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
 * calls; service-level calls don't reach the proxy here (they hit lifecycle
 * endpoints which are exempt).
 */

const jwt = require('jsonwebtoken');
const config = require('./config');

const HDR = {
    auth: 'authorization-app-api',
    appId: 'ex-app-id',
    appVersion: 'ex-app-version',
    aaVersion: 'aa-version',
    requestId: 'aa-request-id',
};

const LIFECYCLE_PATHS = new Set(['/heartbeat', '/init', '/enabled']);

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

function decodeAuthHeader(header) {
    if (!header || typeof header !== 'string') return null;
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
 * Look up a Nextcloud user via OCS using the same shared-secret auth.
 *
 * Cached per-uid for 60s. The connector hits this on EVERY browser request
 * (every fetch of /auth/user, /agents, /api/...) to mint a per-request JWT
 * and derive the user's email. Without the cache, each request adds an
 * extra HTTP round-trip to NC just to get data that rarely changes —
 * doubling perceived latency on every SPA action.
 */
const _userCache = new Map(); // uid → { user, expiresAt }
const USER_CACHE_TTL_MS = 60_000;

async function fetchNextcloudUser(uid) {
    const now = Date.now();
    const cached = _userCache.get(uid);
    if (cached && cached.expiresAt > now) return cached.user;

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
    const body = await res.json();
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
    };
    _userCache.set(uid, { user, expiresAt: now + USER_CACHE_TTL_MS });
    // Bound the cache so churn on a busy NC instance can't leak memory.
    if (_userCache.size > 1000) {
        const oldest = _userCache.keys().next().value;
        if (oldest) _userCache.delete(oldest);
    }
    return user;
}

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
// The connector container only listens on AppAPI's private docker network
// and is reachable solely via NC's AppAPI proxy on the NC container. NC signs
// every forwarded request with the APP_SECRET it minted at install time, so
// the `authorization-app-api` header is already trusted by the time it
// arrives here. Re-verifying the shared secret on every inbound request
// added no security (any attacker who could deliver a request to this port
// has already bypassed the framework boundary) but introduced a brittle
// failure mode: a single drift between NC's stored secret and the container
// env locked out every browser request with a 401. We treat the header as a
// user-identity envelope, not a re-checkable signature. The actually
// load-bearing secret — the per-install tenant key minted by the SaaS at
// bootstrap — is verified end-to-end on every SaaS callback in ncProxy.js
// and on every SaaS-bound JWT below.
function appApiAuthMiddleware(req, res, next) {
    if (LIFECYCLE_PATHS.has(req.path)) return next();
    // Public assets fetched server-to-server by NC (menu icon, embed JS).
    if (req.path.startsWith('/img/') || req.path.startsWith('/js/')) return next();

    const decoded = decodeAuthHeader(req.headers[HDR.auth]);
    if (!decoded) {
        return res.status(401).json({ error: 'Missing AppAPI auth header' });
    }
    const expectedAppId = req.headers[HDR.appId];
    if (expectedAppId && expectedAppId !== config.appId) {
        return res.status(401).json({ error: 'EX-APP-ID mismatch' });
    }

    if (!decoded.userId) {
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
            let token;
            try {
                token = mintSaasJwt(user);
            } catch (e) {
                if (e.code !== 'TENANT_KEY_MISSING') throw e;
                // Bootstrap/verification in flight (no tenant key yet).
                // Connector-owned /setup routes still need to know which NC
                // user is driving setup — expose the identity with a null jwt.
                // Proxied SaaS calls can't work without a key, so they keep the
                // same fallback as a lookup failure (SPA shell for navigations,
                // 502 for XHR).
                req.beeflow = { user, jwt: null };
                if (req.path.startsWith('/setup')) return next();
                if (req.accepts(['html', 'json']) === 'html' && !req.path.startsWith('/api/')) return next();
                return res.status(502).json({ error: 'Tenant key not configured — bootstrap in progress' });
            }
            req.beeflow = { user, jwt: token };
            next();
        })
        .catch(err => {
            console.warn(`[Auth] User lookup failed for ${decoded.userId}: ${err.message}`);
            // When a browser hits the embedded SPA route (Accept: text/html)
            // while bootstrap is in-flight (no tenant key) or NC OCS is
            // briefly unreachable, returning raw JSON paints a useless error
            // page. Serve the SPA shell instead so its error overlay can
            // render with the diagnostics from /setup/diagnostics. Anything
            // requesting JSON (XHR, fetch) still gets the structured 502.
            if (req.accepts(['html', 'json']) === 'html' && !req.path.startsWith('/api/')) {
                return next();
            }
            res.status(502).json({ error: 'User lookup failed' });
        });
}

module.exports = {
    appApiAuthMiddleware,
    decodeAuthHeader,
    fetchNextcloudUser,
    mintSaasJwt,
    HDR,
    LIFECYCLE_PATHS,
};
