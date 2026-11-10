/**
 * AppAPI authentication (Nextcloud AppAPI 5.x).
 *
 * Empirically verified against AppAPI 5.0.2 source — the public docs are
 * stale and reference an older HMAC scheme that no longer exists. Actual
 * scheme is a shared-secret in a single header:
 *
 *   AUTHORIZATION-APP-API: base64(<userId>:<APP_SECRET>)
 *
 * Plus identifying headers (verified, not part of the secret):
 *   AA-VERSION         AppAPI version (informational)
 *   EX-APP-ID          must equal our APP_ID
 *   EX-APP-VERSION     informational
 *   AA-REQUEST-ID      forwarded for log correlation
 *
 * userId is empty for service-level calls (no human in the loop) and a
 * Nextcloud uid otherwise. We mint a SaaS-bound JWT only for human-bound
 * calls; service-level calls don't reach the proxy here (they hit /init,
 * /enabled and /trigger, which need the secret but no user).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { isPinMismatch } = require('./ncTlsPin');
const log = require('./log');
const { errMessage } = require('./errors');
const { NOT_CHOSEN_CODE, NOT_CHOSEN_MESSAGE } = require('./serverChoice');

/** @typedef {import('../types/types').NextcloudUser} NextcloudUser */

const HDR = {
    auth: 'authorization-app-api',
    appId: 'ex-app-id',
    appVersion: 'ex-app-version',
    aaVersion: 'aa-version',
    requestId: 'aa-request-id',
};

// AppAPI sends NO auth header on /heartbeat (it polls it before the install has
// got far enough for anything else), so that one path is let through before a
// single header is parsed. heartbeat.js decides per caller how much it
// discloses (isTrustedLifecycleCaller).
const LIFECYCLE_PATHS = new Set(['/heartbeat']);

// /init and /enabled are NOT in that set. AppAPI signs both with the shared
// secret and an empty userId, base64(":" + APP_SECRET):
//   - /init:    AppAPIService::dispatchExAppInitInternal posts with
//               buildAppAPIAuthHeaders(null, null, $exApp)
//   - /enabled: AppAPIService::enableExApp / disableExApp go through
//               requestToExApp, which adds the same headers
// Read in nextcloud/app_api on stable32, stable33, stable34 and stable35 (the
// versions info.xml supports); HaRP forwards the header unchanged. An earlier
// revision assumed AppAPI sent no header here and let both through
// unauthenticated behind a rate budget; the connector binds 0.0.0.0 on a docker
// network it shares with every other ExApp, so that left /init (about 42 OCS
// writes into the customer's Nextcloud per call) reachable by any neighbour.
// They pass once the secret is verified, whatever the userId part says.
const SIGNED_LIFECYCLE_PATHS = new Set(['/init', '/enabled']);

// Service-level AppAPI calls that carry the shared secret but NO user context.
// AppAPI's Task Processing trigger (ITriggerableProvider) calls the ExApp at
// POST /trigger?providerId=… via requestToExApp with a null userId, so the
// header is base64(":"+APP_SECRET) — a valid secret, empty userId. These paths
// must run rather than 401, but UNLIKE /heartbeat they still pass the
// constant-time secret check below (they are allow-listed in the empty-userId
// branch, not in LIFECYCLE_PATHS which skips the secret entirely).
// The /setup routes that still answer while Nextcloud's certificate is refused
// by the pin (see the lookup failure below).
const PIN_RECOVERY_PATHS = new Set(['/setup/nc-certificate', '/setup/accept-nc-certificate']);

const SERVICE_PATHS = new Set(['/trigger']);

// Paths that are safe to serve without a NC user context. Includes:
//   - SPA shell + assets (index.html, favicon, /assets/*)
//   - /js/* and /img/* — NC's embedded.html template loads these via
//     `Util::addScript`/`Util::addStyle` through its proxy_js/proxy_css
//     mapping. Browser requests come in unsigned-userId because they're
//     declared as PUBLIC routes in info.xml. Blocking them with a 401 here
//     leaves the embedded page blank (no embed.js, no app icon).
//   - Any path ending in a static-asset extension (svg/png/jpg/ico/css/js/
//     woff2/etc.). Components in the SPA bundle may emit hard-coded asset
//     paths like `<img src="bee-flow-logo.svg">` that browsers resolve
//     relative to the iframe URL. These never carry user context.
//
// API/auth/etc. still require a populated AUTHORIZATION-APP-API header to
// mint a SaaS JWT.
const ANON_OK = /^\/(assets\/|js\/|img\/|index\.html$|favicon|$)|\.(svg|png|jpe?g|gif|webp|ico|css|js|woff2?|ttf|otf|eot|map)$/i;

/**
 * Is this a top-level page load (so serving the SPA shell instead of a JSON
 * error is the helpful answer), or an API call the SPA made itself?
 *
 * This used to be `req.accepts(['html','json']) === 'html'`, which is wrong for
 * fetch(): the SPA's authFetch sets no Accept header, so the browser sends
 * `Accept: *&#47;*`, and content negotiation resolves that to the FIRST offered
 * type — 'html'. Every XHR therefore looked like a navigation, so the guarded
 * "502 bootstrap in progress" branches below were unreachable and the request
 * was forwarded to the SaaS with no Authorization header instead.
 *
 * `Sec-Fetch-Mode: navigate` is set by the browser itself, cannot be spoofed by
 * page script, and is exactly this question. Where it is absent (very old
 * browsers, server-to-server), fall back to a GET that explicitly asked for
 * HTML — never a bare `*&#47;*`.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isDocumentNavigation(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const mode = req.headers['sec-fetch-mode'];
    if (mode) return mode === 'navigate';
    const accept = String(req.headers.accept || '');
    return accept.includes('text/html');
}

/**
 * @param {unknown} header  the raw AUTHORIZATION-APP-API header value
 * @returns {{ userId: string, secret: string } | null}
 */
function decodeAuthHeader(header) {
    if (!header || typeof header !== 'string') return null;
    /** @type {string} */
    let decoded;
    try {
        decoded = Buffer.from(header, 'base64').toString('utf8');
    } catch {
        return null;
    }
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { userId: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
}

/**
 * The part of `GET /ocs/v2.php/cloud/users/{uid}` this file reads.
 * @typedef {{ ocs?: { data?: { id: string, email?: string | null, displayname?: string, display_name?: string, groups?: string[], language?: string } } }} OcsUserResponse
 */

/**
 * Look up a Nextcloud user via OCS using the same shared-secret auth.
 *
 * Cached per-uid for 60s. The connector hits this on EVERY browser request
 * (every fetch of /auth/user, /agents, /api/...) to mint a per-request JWT
 * and derive the user's email. Without the cache, each request adds an
 * extra HTTP round-trip to NC just to get data that rarely changes —
 * doubling perceived latency on every SPA action.
 * @type {Map<string, { user: NextcloudUser, expiresAt: number, staleUntil: number }>}
 */
const _userCache = new Map(); // uid → { user, expiresAt, staleUntil }
const USER_CACHE_TTL_MS = 60_000;
// How long a user a lookup once returned may still stand in for a lookup
// that fails now. One failed OCS call used to answer every request of that
// user with 502 for the next 60 s, and the embedded app shows its login
// screen on a failed /auth/user: a blip between the connector and Nextcloud
// logged the person out in the middle of their work.
const USER_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const USER_LOOKUP_RETRY_DELAY_MS = 250;

// One lookup per uid at a time (#454). A page load fires ten to thirty
// requests for the same user at once; when the entry has just expired every
// one of them used to make its own OCS call. On an install that reaches the
// connector through Nextcloud's PHP proxy each browser request already holds
// a PHP worker while it waits here, and each of these calls needs another
// one, so a burst could occupy the whole pool and time every lookup out.
/** @type {Map<string, Promise<NextcloudUser>>} */
const _lookupsInFlight = new Map();
// Nextcloud answers that are not a verdict on the user: a throttle or a
// request timeout is retried like a network error, and the stale user may
// stand in. Every other 4xx (unknown user, refused secret) stands.
const TRANSIENT_4XX = /HTTP 4(08|29)\b/;
let _lastRefreshWarnAt = 0;

/**
 * One OCS call for the user, no caching.
 * @param {string} uid
 * @returns {Promise<NextcloudUser>}
 */
async function lookupNextcloudUser(uid) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const res = await fetch(url, {
        headers: {
            'OCS-APIRequest': 'true',
            'EX-APP-ID': config.appId,
            'EX-APP-VERSION': config.appVersion,
            'AUTHORIZATION-APP-API': Buffer.from(`${uid}:${config.appSecret}`).toString('base64'),
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new Error(`OCS user lookup failed: HTTP ${res.status}`);
    }
    const body = /** @type {OcsUserResponse | null} */ (await res.json());
    const data = body?.ocs?.data;
    if (!data) throw new Error('OCS user lookup returned no data');
    const user = {
        uid: data.id,
        email: data.email || null,
        displayName: data.displayname || data.display_name || data.id,
        // Membership of Nextcloud's built-in `admin` group. Surfaced as a signed
        // `nc_admin` JWT claim (see mintSaasJwt) so the SaaS can let ANY Nextcloud
        // admin through the org onboarding wizard — not just the single admin
        // captured at bootstrap. `/cloud/users/{uid}` returns the user's groups.
        isNcAdmin: Array.isArray(data.groups) && data.groups.includes('admin'),
        // Personal settings → Language. Only picks the language of the
        // connector's own messages (l10n.js); never sent to Bee Flow.
        language: typeof data.language === 'string' && data.language ? data.language : null,
    };
    return user;
}

/**
 * @param {unknown} err
 * @returns {boolean} true when Nextcloud answered with a verdict on the user (a 4xx other than a throttle or timeout)
 */
function isVerdict(err) {
    const msg = errMessage(err);
    return /HTTP 4\d\d/.test(msg) && !TRANSIENT_4XX.test(msg);
}

/**
 * The lookup with its one retry, coalesced per uid. Resolves with the user
 * and stores it; rejects with Nextcloud's verdict or the last transient error.
 * @param {string} uid
 * @returns {Promise<NextcloudUser>}
 */
function lookupCoalesced(uid) {
    const running = _lookupsInFlight.get(uid);
    if (running) return running;
    const p = (async () => {
        /** @type {NextcloudUser} */
        let user;
        try {
            user = await lookupNextcloudUser(uid);
        } catch (first) {
            // A 4xx is Nextcloud's verdict (unknown user, refused secret) and
            // stands; a timeout, a reset, a throttle or a 5xx gets one more try.
            if (isVerdict(first)) throw first;
            await new Promise((resolve) => setTimeout(resolve, USER_LOOKUP_RETRY_DELAY_MS));
            user = await lookupNextcloudUser(uid);
        }
        const now = Date.now();
        // Re-insert so the Map keeps insertion order as recency: the eviction
        // below then drops the least recently refreshed user, not the first
        // one ever seen.
        _userCache.delete(uid);
        _userCache.set(uid, { user, expiresAt: now + USER_CACHE_TTL_MS, staleUntil: now + USER_STALE_TTL_MS });
        // Bound the cache so churn on a busy NC instance can't leak memory.
        if (_userCache.size > 1000) {
            const oldest = _userCache.keys().next().value;
            if (oldest) _userCache.delete(oldest);
        }
        return user;
    })().finally(() => _lookupsInFlight.delete(uid));
    _lookupsInFlight.set(uid, p);
    return p;
}

/**
 * Refresh an expired entry without holding the request. A verdict drops the
 * entry so the next request asks Nextcloud and gets that verdict itself; a
 * transient failure keeps the stale user for up to a day.
 * @param {string} uid
 */
function refreshInBackground(uid) {
    if (_lookupsInFlight.has(uid)) return;
    lookupCoalesced(uid).catch((err) => {
        if (isVerdict(err)) {
            _userCache.delete(uid);
            return;
        }
        const now = Date.now();
        if (now - _lastRefreshWarnAt < 60_000) return;
        _lastRefreshWarnAt = now;
        log.warn(`[Auth] Refreshing the Nextcloud user for ${log.ref(uid)} failed twice (${errMessage(err)}); the user from the last lookup stands in for up to a day`);
    });
}

/**
 * The user for a request. A fresh entry answers at once; an expired one
 * answers at once too and is refreshed behind the request (the embedded app
 * used to show its sign-in screen whenever the refresh of a busy user hit a
 * blip); only a uid this process has never resolved waits for Nextcloud.
 * @param {string} uid
 * @returns {Promise<NextcloudUser>}
 */
async function fetchNextcloudUser(uid) {
    const now = Date.now();
    const cached = _userCache.get(uid);
    if (cached && cached.expiresAt > now) return cached.user;
    if (cached && cached.staleUntil > now) {
        refreshInBackground(uid);
        return cached.user;
    }
    return lookupCoalesced(uid);
}

/**
 * Test hook: settle every lookup in flight (the background refreshes included).
 * @returns {Promise<void>}
 */
async function _settleLookupsForTests() {
    await Promise.allSettled([..._lookupsInFlight.values()]);
}

/**
 * @param {NextcloudUser} user
 * @returns {string}
 */
function mintSaasJwt(user) {
    if (!config.tenantKey) {
        const err = new Error('Tenant key not configured — bootstrap may have failed');
        err.code = 'TENANT_KEY_MISSING';
        throw err;
    }
    return jwt.sign(
        { sub: user.uid, email: user.email, name: user.displayName, nc_admin: !!user.isNcAdmin },
        config.tenantKey,
        {
            algorithm: 'HS256',
            issuer: 'nextcloud-connector',
            audience: 'beeflow.nl',
            expiresIn: config.jwtTtlSeconds,
        }
    );
}

// Trust boundary
// ──────────────
// `AUTHORIZATION-APP-API` carries base64(<userId>:<APP_SECRET>). The shared
// secret half is what makes the userId half trustworthy, so it is verified in
// constant time on every request that claims a user.
//
// This used to be skipped, on the reasoning that the container is only
// reachable through Nextcloud's AppAPI proxy and NC has already signed the
// request. That reasoning does not hold: the connector binds 0.0.0.0 and shares
// a Docker network with Nextcloud, its deploy daemon and every other ExApp on
// the instance. Anything on that network could therefore send
// `base64("admin:anything")` and be handed a freshly minted SaaS JWT for the
// Nextcloud administrator — Bee Flow account takeover from a neighbouring
// container, with no Nextcloud session anywhere in the story. Nextcloud's own
// guidance is explicit that authorisation checks belong in the app even where
// the framework looks like it has already made them
// (developer_manual/prologue/security.html, "Authentication bypass").
//
// The failure mode that motivated skipping the check is real but narrow: if
// Nextcloud's stored secret and the container's APP_SECRET drift apart, every
// request 401s. That is now a loud, named error with the exact `occ` command
// that repairs it, rather than a silently open door.
const _appSecretBuf = Buffer.from(String(config.appSecret), 'utf8');
let _lastSecretWarnAt = 0;

/**
 * @param {string | null | undefined} secret
 * @returns {boolean}
 */
function secretMatches(secret) {
    const got = Buffer.from(String(secret == null ? '' : secret), 'utf8');
    if (got.length !== _appSecretBuf.length) return false;
    return crypto.timingSafeEqual(got, _appSecretBuf);
}

// Once a minute at most: a broken deployment retries on every SPA poll, and a
// log line per request buries the one that explains the fix.
/** @param {string} userId */
function warnSecretMismatch(userId) {
    const now = Date.now();
    if (now - _lastSecretWarnAt < 60_000) return;
    _lastSecretWarnAt = now;
    log.warn(`[Auth] rejected a request for uid=${userId ? log.ref(userId) : '(service)'}: the `
        + `AUTHORIZATION-APP-API shared secret does not match this container's APP_SECRET. `
        + `If this is not an attack, Nextcloud and the container hold different secrets — `
        + `re-register the ExApp (occ app_api:app:unregister ${config.appId} && `
        + `occ app_api:app:register ${config.appId}) to mint a matching pair.`);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function appApiAuthMiddleware(req, res, next) {
    if (LIFECYCLE_PATHS.has(req.path)) return next();
    // Public assets fetched server-to-server by NC (menu icon, embed JS).
    if (req.path.startsWith('/img/') || req.path.startsWith('/js/')) return next();

    const decoded = decodeAuthHeader(req.headers[HDR.auth]);
    if (!decoded) {
        return res.status(401).json({ error: 'Missing AppAPI auth header' });
    }
    if (!secretMatches(decoded.secret)) {
        warnSecretMismatch(decoded.userId);
        return res.status(401).json({
            code: 'appapi_secret_mismatch',
            error: 'Invalid AppAPI shared secret',
        });
    }
    const expectedAppId = req.headers[HDR.appId];
    if (expectedAppId && expectedAppId !== config.appId) {
        return res.status(401).json({ error: 'EX-APP-ID mismatch' });
    }

    // Lifecycle calls need the secret and nothing else: no user lookup, no JWT.
    if (SIGNED_LIFECYCLE_PATHS.has(req.path)) return next();

    if (!decoded.userId) {
        // Service-level AppAPI calls (Task Processing trigger) carry the secret
        // but no user — let them through now that the secret is verified.
        if (SERVICE_PATHS.has(req.path)) return next();
        // PUBLIC route reached anonymously (NC user not logged in). Serve
        // the SPA shell — but reject SaaS-bound requests with a clear error
        // so the SPA can show a recognizable login-required state instead
        // of silently failing or showing stale data.
        if (ANON_OK.test(req.path)) return next();
        return res.status(401).json({
            error: 'NC session not visible — please refresh after logging in',
        });
    }

    fetchNextcloudUser(decoded.userId)
        .then(user => {
            /** @type {string} */
            let token;
            try {
                token = mintSaasJwt(user);
            } catch (e) {
                if (!(e instanceof Error) || e.code !== 'TENANT_KEY_MISSING') throw e;
                // Bootstrap/verification in flight (no tenant key yet).
                // Connector-owned /setup routes still need to know which NC
                // user is driving setup — expose the identity with a null jwt.
                // Proxied SaaS calls can't work without a key, so they keep the
                // same fallback as a lookup failure (SPA shell for navigations,
                // 502 for XHR).
                req.beeflow = { user, jwt: null };
                if (req.path.startsWith('/setup')) return next();
                if (isDocumentNavigation(req)) return next();
                // The SPA bundle itself needs no tenant key — and it IS the
                // setup UI. 502ing the shell's own assets deadlocked bootstrap:
                // the navigation got index.html, every asset it referenced got
                // this JSON 502 (browser: "Refused to apply style … MIME type
                // application/json"), so the embedded view stayed blank and the
                // admin had nowhere to enter the verification code that would
                // have produced the key. Same static-asset predicate as the
                // anonymous branch above.
                if (ANON_OK.test(req.path)) return next();
                // No server chosen: there is no bootstrap to wait for. A normal
                // page load in this state makes no such call (it gets the setup
                // page from the gate in server.js).
                if (!config.apiBaseUrl) {
                    return res.status(503).json({ error: NOT_CHOSEN_MESSAGE, code: NOT_CHOSEN_CODE });
                }
                return res.status(502).json({ error: 'Tenant key not configured — bootstrap in progress' });
            }
            req.beeflow = { user, jwt: token };
            next();
        })
        .catch((/** @type {unknown} */ err) => {
            log.warn(`[Auth] User lookup failed for ${log.ref(decoded.userId)}: ${errMessage(err)}`);
            // Nextcloud's certificate changed and the pin refuses it (#403):
            // every lookup fails, including the one that would show this admin
            // the way out. Only the two certificate routes go on, without an
            // admin claim; they are ADMIN routes in info.xml, so AppAPI has
            // checked the admin before forwarding (setup.js requirePinRecovery).
            if (isPinMismatch(err) && PIN_RECOVERY_PATHS.has(req.path)) {
                req.beeflow = {
                    user: { uid: decoded.userId, email: null, displayName: decoded.userId, isNcAdmin: false },
                    jwt: null,
                    ncTlsPinRecovery: true,
                };
                return next();
            }
            // When a browser hits the embedded SPA route (Accept: text/html)
            // while bootstrap is in-flight (no tenant key) or NC OCS is
            // briefly unreachable, returning raw JSON paints a useless error
            // page. Serve the SPA shell instead so its error overlay can
            // render with the diagnostics from /setup/diagnostics. Anything
            // requesting JSON (XHR, fetch) still gets the structured 502.
            if (isDocumentNavigation(req)) {
                return next();
            }
            res.status(502).json({ error: 'User lookup failed' });
        });
}

module.exports = {
    appApiAuthMiddleware,
    _resetUserCacheForTests: () => { _userCache.clear(); _lookupsInFlight.clear(); },
    _settleLookupsForTests,
    // Drop one user from the lookup cache: the next request asks Nextcloud.
    forgetUser: (/** @type {string} */ uid) => { _userCache.delete(uid); },
    isDocumentNavigation,
    decodeAuthHeader,
    secretMatches,
    fetchNextcloudUser,
    mintSaasJwt,
    HDR,
    LIFECYCLE_PATHS,
};
