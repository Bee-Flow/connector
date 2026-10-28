/**
 * NC reverse-proxy for the Bee Flow SaaS.
 *
 * Out-of-box NC integrations (Files, Calendar, Mail, Contacts, …) need to
 * make HTTP calls into the customer's Nextcloud on behalf of a specific
 * user. The traditional path was: ask the user for an app-password, store
 * it, present it as Basic auth on every request. That requires user setup.
 *
 * AppAPI gives us a better option: ExApp shared-secret with impersonation.
 * Setting `AUTHORIZATION-APP-API: base64(<userUid>:<APP_SECRET>)` lets the
 * connector make calls as that user without ever holding their password.
 *
 * This module mounts a second proxy under `/nc/*` that the SaaS hits via
 * the connector's public URL. We rewrite Authorization, attach the AppAPI
 * shared-secret with the right user uid, and forward to the customer's NC.
 *
 * The user uid comes from a header the SaaS sets (`X-Beeflow-NC-Uid`) which
 * derives from the Bee Flow JWT — the SaaS already knows the NC uid for
 * each connector-authenticated user (see server/auth/connectorJwt.js).
 *
 * Inbound auth check: the SaaS authenticates to the connector with an HMAC of
 * (timestamp + method + path + ncUid + sha256(body)) using the tenant key.
 * Anyone else hitting /nc/* gets 401. Without this, a malicious SPA could call
 * /nc/* directly and impersonate any NC user.
 *
 * The body hash is load-bearing, not decoration. Every write verb is tunnelled
 * over POST + X-HTTP-Method-Override (AppAPI's proxy rejects raw PROPFIND /
 * PUT / MOVE …), so a signature that covered only method+path would be a
 * five-minute licence to overwrite that exact file with arbitrary content. A
 * replay cache closes the matching hole for byte-identical retries.
 *
 * Routes proxied (everything else returns 404):
 *   /nc/ocs/*               → /ocs/...                  (provisioning, capabilities, etc.)
 *   /nc/remote.php/dav/*    → /remote.php/dav/...       (WebDAV / CalDAV / CardDAV)
 *   /nc/index.php/apps/*    → /index.php/apps/...       (Mail, Deck, Notes, Talk, etc.)
 */

const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const config = require('./config');
const { ncHttpsAgent, ncTlsMode } = require('./ncTls');
const rateLimit = require('./rateLimit');
const log = require('./log');
const { isExpressResponse } = require('./httpGuards');
const { errMessage } = require('./errors');

const ALLOWED_PREFIXES = ['/ocs/', '/remote.php/dav/', '/index.php/apps/'];

/**
 * A size in MiB from the environment, as bytes; 0 = no cap.
 * @param {string} name
 * @param {number} fallbackMb
 */
function mbFromEnv(name, fallbackMb) {
    const raw = process.env[name];
    const mb = raw === undefined || raw === '' ? fallbackMb : Number(raw);
    if (!Number.isFinite(mb) || mb < 0) return fallbackMb * 1024 * 1024;
    return mb === 0 ? Infinity : Math.floor(mb * 1024 * 1024);
}

// The largest body one /nc/* request may carry (a WebDAV upload from Bee Flow),
// and the most body bytes all /nc/* requests together may hold in memory while
// they wait for their signature check. The signature covers sha256(body), so
// the body has to be read before it can be verified; these caps keep a flood of
// signature-shaped junk from filling the container's memory. 0 = no cap.
const MAX_BODY_BYTES = mbFromEnv('BEEFLOW_NC_PROXY_MAX_BODY_MB', 100);
const MAX_INFLIGHT_BYTES = mbFromEnv('BEEFLOW_NC_PROXY_MAX_INFLIGHT_MB', 512);
let _inflightBytes = 0;

// Brute-force gate on the HMAC. Only failures are billed — the Bee Flow server
// legitimately makes a lot of these calls, and throttling those would break
// user-visible features, while a caller producing 60 bad signatures a minute is
// guessing at the tenant key.
const sigLimiter = rateLimit.penalise('nc-proxy-sig', { limit: 60, windowMs: 60_000 });

/**
 * Is this path one we are willing to forward into Nextcloud?
 *
 * The allow-list is checked against the DECODED, NORMALISED path: `/ocs/` was
 * otherwise satisfiable by `/ocs/../remote.php/webdav/...` and by its
 * percent-encoded spellings, which turns a three-prefix allow-list into "any
 * Nextcloud endpoint". Nextcloud's own guidance on directory traversal is to
 * strip the traversal before acting on a caller-supplied path
 * (developer_manual/prologue/security.html); refusing it outright is the
 * stricter form and costs nothing here, because no legitimate WebDAV or OCS URL
 * contains a `..` segment.
 * @param {string | undefined} rawUrl
 * @returns {boolean}
 */
function isAllowedNcPath(rawUrl) {
    const withoutQuery = String(rawUrl || '').split('?')[0];
    let decoded = withoutQuery;
    // Decode repeatedly: `%252e%252e` is `%2e%2e` after one pass and `..` after
    // two, and NC/HaRP may decode once before we ever see the request.
    for (let i = 0; i < 3; i++) {
        /** @type {string} */
        let next;
        try { next = decodeURIComponent(decoded); } catch { break; }
        if (next === decoded) break;
        decoded = next;
    }
    const candidates = [withoutQuery, decoded];
    for (const candidate of candidates) {
        const normalised = candidate.replace(/\\/g, '/');
        if (normalised.split('/').includes('..')) return false;
        if (normalised.includes('\0')) return false;
    }
    return ALLOWED_PREFIXES.some(p => decoded.startsWith(p))
        && ALLOWED_PREFIXES.some(p => withoutQuery.startsWith(p));
}

/**
 * Hosts a WebDAV `Destination` header may name: the host this request arrived on
 * (directly or through a proxy) and the Nextcloud host the Bee Flow server was
 * given as callback (internal and public). AppAPI and HaRP rewrite the request
 * line but not this header, so it still carries the Nextcloud-side spelling.
 * @param {import('express').Request} req
 * @returns {Set<string>}
 */
function destinationHosts(req) {
    const hosts = new Set();
    const add = (/** @type {unknown} */ value) => {
        const first = String(value || '').split(',')[0].trim().toLowerCase();
        if (first) hosts.add(first);
    };
    add(req.headers.host);
    add(req.headers['x-forwarded-host']);
    for (const base of [config.nextcloudUrl, config.nextcloudPublicUrl]) {
        try { if (base) add(new URL(base).host); } catch { /* unparsable config: skip */ }
    }
    return hosts;
}

/**
 * Rewrite a WebDAV `Destination` (MOVE, COPY, trash restore) from the proxy's
 * public spelling (`<callback>/nc/remote.php/dav/...`) to the Nextcloud URL.
 * Sabre otherwise resolves it outside its base URI and answers 403.
 *
 * The rewritten path must itself sit under `/remote.php/dav/` and pass
 * isAllowedNcPath, so the header is not a way around the path allow-list. The
 * host is compared on the parsed URL, never as a string prefix.
 *
 * @param {import('express').Request} req
 * @returns {{ ok: true, destination: string | null } | { ok: false }}
 */
function rewriteDestination(req) {
    const raw = req.headers.destination;
    if (raw === undefined) return { ok: true, destination: null };
    const header = Array.isArray(raw) ? raw[0] : raw;
    // Anything but an absolute http(s) URL (a relative path, a data: URL, control
    // characters, backslashes the URL parser would read as slashes) is refused.
    const match = /^(https?):\/\/([^/?#\\\s]+)(\/[^?#\\\s]*)$/i.exec(header);
    if (!match) return { ok: false };
    let url;
    try { url = new URL(header); } catch { return { ok: false }; }
    if (url.username || url.password) return { ok: false };
    if (!destinationHosts(req).has(url.host.toLowerCase())) return { ok: false };
    // The RAW path (the parsed one has its dot segments already resolved).
    let path = match[3];
    const appId = encodeURIComponent(config.appId);
    for (const prefix of [`/index.php/apps/app_api/proxy/${appId}`, `/exapps/${appId}`]) {
        if (path.startsWith(`${prefix}/nc/`)) { path = path.slice(prefix.length); break; }
    }
    if (!path.startsWith('/nc/')) return { ok: false };
    const upstreamPath = path.slice('/nc'.length);
    if (!upstreamPath.startsWith('/remote.php/dav/') || !isAllowedNcPath(upstreamPath)) {
        return { ok: false };
    }
    return { ok: true, destination: `${config.nextcloudUrl}${upstreamPath}` };
}

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

/** @param {import('express').Request} req */
function bodyHashOf(req) {
    const body = req.body;
    if (Buffer.isBuffer(body) && body.length) {
        return crypto.createHash('sha256').update(body).digest('hex');
    }
    return EMPTY_BODY_SHA256;
}

// On replay: there is deliberately no signature-dedup cache here. Two
// legitimate identical requests in the same second (parallel reads of the same
// path for the same user, or a throttle retry) produce the same signature, so
// a dedup cache rejects real traffic. Now that the signature covers
// sha256(body), a replay can only reproduce a request that already succeeded —
// it cannot substitute different content. Adding true replay protection means
// a client nonce in the signed message, not deduping the signature itself.

// Canonical form: the connector's copy of server/integrations/ncSigning.js
// (canonicalQuery, canonicalSignedPath; cross-repo vector in test/ncProxy.test.js
// pins both). The AppAPI/HaRP hop re-encodes the query (`%20` -> `+`), so the
// raw string can't be compared: decode each pair as form data and re-emit with
// `% & = + #`, space, CR and LF escaped. Injective, and strict: an escape that
// is not valid UTF-8 throws (URLSearchParams would fold %FF and %FE together).
const CANONICAL_MARKER = 'c1';
/**
 * @param {string} s
 * @param {RegExp} re
 */
const escChars = (s, re) => s.replace(re,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
/** @param {string} s */
const formDecode = (s) => decodeURIComponent(s.replace(/\+/g, ' '));

/**
 * @param {string} query
 * @returns {string}
 */
function canonicalQuery(query) {
    /** @type {string[]} */
    const out = [];
    for (const part of String(query).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = formDecode(eq < 0 ? part : part.slice(0, eq));
        const v = eq < 0 ? '' : formDecode(part.slice(eq + 1));
        out.push(`${escChars(k, /[%&=+# \r\n]/g)}=${escChars(v, /[%&=+# \r\n]/g)}`);
    }
    return out.join('&');
}

// Decoded path with `% ? CR LF` escaped, plus the canonical query. null when
// any escape is invalid: the canonical scheme is then refused outright.
/**
 * @param {string} rawUrl
 * @returns {string | null}
 */
function canonicalSignedPath(rawUrl) {
    try {
        const q = rawUrl.indexOf('?');
        const path = escChars(decodeURIComponent(q < 0 ? rawUrl : rawUrl.slice(0, q)), /[%?\r\n]/g);
        return q < 0 ? path : `${path}?${canonicalQuery(rawUrl.slice(q + 1))}`;
    } catch {
        return null;
    }
}

/**
 * The checks that need no body, run BEFORE a single body byte is buffered:
 * a tenant key exists, the signature header is well formed, its timestamp is
 * inside the skew window. Returns the reason to refuse, or null.
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function signatureHeaderProblem(req) {
    if (!config.tenantKey) return 'no_tenant_key';
    const sigHeader = req.headers['x-beeflow-sig'];
    if (!sigHeader || typeof sigHeader !== 'string') return 'missing_signature';
    const m = /^(\d{1,12})\.([0-9a-fA-F]{64})$/.exec(sigHeader);
    if (!m) return 'malformed_signature';
    const ts = parseInt(m[1], 10);
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > config.sigSkewSeconds) return 'stale_signature';
    return null;
}

/**
 * Read the request body into req.body (a Buffer), capped per request and in
 * total across requests still waiting for their signature check. A refusal
 * answers at once with Connection: close, so the rest of the upload is never
 * read. The bytes count against the total until the response is done.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function readCappedBody(req, res, next) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        res.set('Connection', 'close');
        return res.status(413).json({ error: 'Request body too large' });
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let held = 0;
    let settled = false;
    const release = () => { _inflightBytes -= held; held = 0; };
    res.on('close', release);
    /**
     * @param {number} status
     * @param {string} error
     */
    const refuse = (status, error) => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        release();
        req.removeListener('data', onData);
        if (!res.headersSent) {
            res.set('Connection', 'close');
            if (status === 503) res.set('Retry-After', '5');
            res.status(status).json({ error });
        }
    };
    /** @param {Buffer} chunk */
    function onData(chunk) {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return refuse(413, 'Request body too large');
        if (_inflightBytes + chunk.length > MAX_INFLIGHT_BYTES) {
            log.warn(`[NcProxy] ${Math.round(_inflightBytes / 1048576)} MiB of /nc bodies in flight — refusing ${req.method} ${req.url} with 503`);
            return refuse(503, 'Connector busy, try again shortly');
        }
        _inflightBytes += chunk.length;
        held += chunk.length;
        chunks.push(chunk);
    }
    req.on('data', onData);
    req.on('end', () => {
        if (settled) return;
        settled = true;
        // Same rule as body-parser's hasBody: a request that announced no
        // body keeps none, so the proxy streams it as before.
        const announced = req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined;
        if (size > 0 || announced) req.body = Buffer.concat(chunks, size);
        next();
    });
    req.on('error', () => { settled = true; release(); });
}

/** @returns {number} body bytes currently held by /nc/* requests (for tests and diagnostics) */
function inflightBodyBytes() {
    return _inflightBytes;
}

// Constant-time HMAC verification of `<ts>.<sig>` using tenant key.
// The SaaS sends `X-Beeflow-Sig: <unixSeconds>.<hexHmac>`. Skew tolerance
// is governed by config.sigSkewSeconds (BEEFLOW_SIG_SKEW_SECONDS). Without
// the tenant key (bootstrap hasn't completed), we deny all /nc/* — fail-closed.
/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function verifyHmac(req) {
    const tenantKey = config.tenantKey;
    if (!tenantKey) return false;
    const sigHeader = req.headers['x-beeflow-sig'];
    if (!sigHeader || typeof sigHeader !== 'string') return false;
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return false;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > config.sigSkewSeconds) return false;

    const ncUid = String(req.headers['x-beeflow-nc-uid'] || '');
    const rawPath = req.originalUrl || req.url;
    // The SaaS signs the HMAC over the DECODED path, because the NC/HaRP proxy
    // in front of this route percent-decodes the URL before we see it (e.g.
    // `%40` → `@`) — signing the encoded form broke the signature for any path
    // with reserved chars (calendar event UIDs end in `@host`; calendars can be
    // named like emails). We verify against the decoded path; we also still
    // accept the raw path so an older SaaS keeps working during rollout. The
    // two collapse to one candidate when the path has no percent-escapes.
    let decodedPath = rawPath;
    try { decodedPath = decodeURIComponent(rawPath); } catch { /* keep raw */ }
    // WebDAV methods are tunnelled over POST + X-HTTP-Method-Override (NC's
    // AppAPI proxy rejects raw PROPFIND/REPORT/… with 405). The SaaS signs the
    // HMAC over the REAL method, so verify against the override when present —
    // this also means the override can't be swapped without invalidating the
    // signature.
    const signedMethod = String(req.headers['x-http-method-override'] || req.method).toUpperCase();
    // Buffer.from(str, 'hex') never throws — it truncates at the first invalid
    // pair — so the length comparison below is what rejects malformed input.
    const sigBuf = Buffer.from(sig, 'hex');
    if (sigBuf.length !== 32) return false;

    // Canonical scheme: the message carries the `c1` marker, and ONLY that
    // scheme accepts the canonical path. The pre-canonical forms (decoded and
    // raw path, no marker) stay for an older SaaS during rollout; they can
    // never verify a canonical signature, nor the reverse, because the marker is
    // inside the HMAC. Without that separation a signature over `term=a%20b`
    // would also verify the different request `term=a%2520b` via the decoded form.
    // REMOVAL CRITERION (legacy forms): every SaaS signs `c1`.
    const canonical = canonicalSignedPath(rawPath);
    if (canonical !== null) {
        const message = `${ts}\n${signedMethod}\n${canonical}\n${ncUid}\n${bodyHashOf(req)}\n${CANONICAL_MARKER}`;
        const expected = crypto.createHmac('sha256', tenantKey).update(message).digest();
        if (crypto.timingSafeEqual(expected, sigBuf)) return true;
    }
    // Legacy: a CR/LF in the path could otherwise forge extra message fields.
    if (/[\r\n]/.test(decodedPath)) return false;
    const paths = decodedPath === rawPath ? [rawPath] : [decodedPath, rawPath];
    // v2 binds the body; v1 is the pre-body-hash form, accepted for one release
    // so a SaaS/connector version skew doesn't break customers mid-rollout.
    //
    // REMOVAL CRITERION: the SaaS side no longer signs v1 anywhere — the last
    // v1 signer was services/ncUserGroupSync.js, which now uses the shared
    // integrations/ncSigning.js helper. Drop the trailing '' suffix (and this
    // comment) once every deployed SaaS is at or past that build; the
    // cross-repo vector in test/ncProxy.test.js pins the v2 form that stays.
    const suffixes = [`\n${bodyHashOf(req)}`, ''];
    for (const path of paths) {
        for (const suffix of suffixes) {
            const message = `${ts}\n${signedMethod}\n${path}\n${ncUid}${suffix}`;
            const expected = crypto.createHmac('sha256', tenantKey).update(message).digest();
            if (crypto.timingSafeEqual(expected, sigBuf)) return true;
        }
    }
    return false;
}

function buildNcProxy() {
    const isHttps = String(config.nextcloudUrl || '').startsWith('https://');
    /** @type {import('http-proxy-middleware').Options<import('express').Request, import('express').Response>} */
    const options = {
        target: config.nextcloudUrl,
        changeOrigin: true,
        // Match the connector→NC TLS posture from ncTls.js for the reverse
        // proxy too (http-proxy-middleware uses node http(s), not fetch). When
        // NC has a self-signed/internal cert, `secure:false` + the relaxed
        // agent let these calls through for the NC origin only; a pinned CA or
        // a valid cert keeps `secure:true` so verification still happens.
        ...(isHttps ? { agent: ncHttpsAgent, secure: ncTlsMode !== 'insecure' } : {}),
        // Strip the /nc prefix so /nc/ocs/v2.php/... → /ocs/v2.php/... upstream
        pathRewrite: { '^/nc': '' },
        on: {
            proxyReq: (proxyReq, req) => {
                const ncUid = String(req.headers['x-beeflow-nc-uid'] || '').trim();
                // AppAPI impersonation: empty uid means "service-level" request.
                // Most user-data endpoints (WebDAV, mail) require a real uid.
                const auth = Buffer.from(`${ncUid}:${config.appSecret}`).toString('base64');
                proxyReq.setHeader('AUTHORIZATION-APP-API', auth);
                proxyReq.setHeader('EX-APP-ID', config.appId);
                proxyReq.setHeader('EX-APP-VERSION', config.appVersion);
                if (proxyReq.path.startsWith('/ocs/')) {
                    proxyReq.setHeader('OCS-APIRequest', 'true');
                }
                // Strip incoming auth + cookies — we authenticate with AppAPI
                // shared-secret, not whatever the SaaS sent us. Also strip the
                // Bee Flow internal routing headers so they never leak to NC.
                proxyReq.removeHeader('authorization');
                proxyReq.removeHeader('cookie');
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');
                proxyReq.removeHeader('x-beeflow-sig'); // never leak HMAC sigs upstream
                proxyReq.removeHeader('x-beeflow-nc-uid'); // internal impersonation hint
                proxyReq.removeHeader('x-http-method-override'); // already applied to req.method
                // We consumed the request stream to hash the body for the HMAC
                // (readCappedBody, mounted in mount() below), so replay the exact
                // bytes upstream. Raw bytes — not a parsed-and-re-serialised
                // object: this path carries WebDAV file uploads, and
                // round-tripping a .json file through JSON.parse/stringify
                // rewrites its formatting and rejects any file that isn't valid
                // JSON.
                if (Buffer.isBuffer(req.body)) {
                    proxyReq.removeHeader('transfer-encoding');
                    proxyReq.setHeader('Content-Length', req.body.length);
                    if (req.body.length) proxyReq.write(req.body);
                    proxyReq.end();
                }
            },
            error: (err, req, res) => {
                if (!isExpressResponse(res)) return;
                log.error(`[NcProxy] ${req.method} ${req.url}: ${errMessage(err)}`);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Nextcloud is unreachable from the connector' });
                }
            },
        },
    };
    return createProxyMiddleware(options);
}

/** @param {import('express').Express} app */
function mount(app) {
    const proxy = buildNcProxy();
    /**
     * Bill a signature failure and answer it (401, or 429 over budget).
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    const rejectSignature = (req, res) => {
        const verdict = sigLimiter.fail();
        _recordSigFailure(req);
        if (!verdict.allowed) {
            res.set('Retry-After', String(Math.ceil(sigLimiter.windowMs / 1000)));
            return res.status(429).json({ error: 'Too many invalid signatures' });
        }
        return res.status(401).json({ error: 'Missing or invalid X-Beeflow-Sig' });
    };
    // Path and signature header first, before any body byte is read: an
    // unsigned 90 MB POST used to be buffered in full before its 401.
    app.use('/nc', (req, res, next) => {
        // Allowed-prefix check after pathRewrite would happen too late; do it here.
        if (!isAllowedNcPath(req.url)) {
            res.set('Connection', 'close');
            return res.status(404).json({ error: 'Path not proxied' });
        }
        if (signatureHeaderProblem(req)) {
            res.set('Connection', 'close');
            return rejectSignature(req, res);
        }
        return next();
    });
    // Then the body as raw bytes for every content type: the HMAC covers
    // sha256(body), and WebDAV uploads must reach Nextcloud byte-for-byte.
    app.use('/nc', readCappedBody, (req, res, next) => {
        // Verify the HMAC FIRST, then bill only a genuine failure. Checking a
        // blocked() gate BEFORE verifying would let a flood of forged signatures
        // (this route is PUBLIC) 429 the legitimate Bee Flow server too — its
        // valid request would never reach succeed(), so the block would persist
        // for the whole window and take out all SaaS→NC access. The HMAC is one
        // SHA256, so a valid caller is now never collateral to an attacker's
        // failures; a forged one is still counted and 429'd once over budget.
        if (!verifyHmac(req)) return rejectSignature(req, res);
        sigLimiter.succeed();
        _sigFailures.consecutive = 0;
        // Restore the real WebDAV method from the tunnel BEFORE http-proxy builds
        // the upstream request (changing proxyReq.method later is too late — the
        // method is fixed when the ClientRequest is created). The signature was
        // verified over this real method above, so this can't bypass auth.
        const override = req.headers['x-http-method-override'];
        if (override) {
            req.method = String(override).toUpperCase();
            delete req.headers['x-http-method-override'];
        }
        // WebDAV MOVE/COPY/restore name their target in a header that the proxy
        // hops do not rewrite; refuse one that leads anywhere but the DAV tree.
        const dest = rewriteDestination(req);
        if (!dest.ok) {
            return res.status(403).json({ error: 'Destination not allowed' });
        }
        if (dest.destination) req.headers.destination = dest.destination;
        return proxy(req, res, next);
    });
}

/**
 * Signature-failure telemetry, surfaced through /heartbeat.
 *
 * Under HaRP a source IP is banned after HP_BLACKLIST_COUNT (default 10)
 * 4xx/5xx responses within HP_BLACKLIST_WINDOW (default 300s). Every /nc/*
 * request comes from the SaaS's single egress address, so a run of rejected
 * signatures — a clock that has drifted past the skew window, a tenant key
 * rotated on one side only — does not merely fail those calls: it can get
 * Bee Flow's own backend banned, which takes out file access AND user/group
 * sync for the whole tenant until the window expires.
 *
 * A 401 here is therefore an operational signal, not just an auth outcome.
 * Counting it makes the precursor visible to an admin (and to
 * /setup/diagnostics) BEFORE the ban lands.
 * @type {{ total: number, consecutive: number, lastAt: string | null, lastReason: string | null }}
 */
const _sigFailures = { total: 0, consecutive: 0, lastAt: null, lastReason: null };

/** @param {import('express').Request} req */
function _recordSigFailure(req) {
    _sigFailures.total += 1;
    _sigFailures.consecutive += 1;
    _sigFailures.lastAt = new Date().toISOString();
    _sigFailures.lastReason = req.headers['x-beeflow-sig'] ? 'signature_mismatch_or_skew' : 'missing_signature';
    // Loud at the point a HaRP ban becomes plausible, quiet before that.
    if (_sigFailures.consecutive === 5 || _sigFailures.consecutive % 10 === 0) {
        log.warn(
            `[ncProxy] ${_sigFailures.consecutive} consecutive signature rejections `
            + `(${_sigFailures.lastReason}). Under HaRP ~10 within 300s bans the caller's IP — `
            + 'check clock skew between the Bee Flow server and this host, and that the tenant key matches.'
        );
    }
}

function sigFailureStats() {
    return { ..._sigFailures };
}

module.exports = { mount, verifyHmac, inflightBodyBytes, MAX_BODY_BYTES, canonicalQuery, canonicalSignedPath, isAllowedNcPath, rewriteDestination, ALLOWED_PREFIXES, sigFailureStats };
