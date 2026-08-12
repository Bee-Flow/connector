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

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const config = require('./config');
const { ncHttpsAgent, ncTlsMode } = require('./ncTls');

const ALLOWED_PREFIXES = ['/ocs/', '/remote.php/dav/', '/index.php/apps/'];

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

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

// Constant-time HMAC verification of `<ts>.<sig>` using tenant key.
// The SaaS sends `X-Beeflow-Sig: <unixSeconds>.<hexHmac>`. Skew tolerance
// is governed by config.sigSkewSeconds (BEEFLOW_SIG_SKEW_SECONDS). Without
// the tenant key (bootstrap hasn't completed), we deny all /nc/* — fail-closed.
function verifyHmac(req) {
    if (!config.tenantKey) return false;
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

    const paths = decodedPath === rawPath ? [rawPath] : [decodedPath, rawPath];
    // v2 binds the body; v1 is the pre-body-hash form, accepted for one release
    // so a SaaS/connector version skew doesn't break customers mid-rollout.
    // Remove the v1 suffix once every deployed server signs v2.
    const suffixes = [`\n${bodyHashOf(req)}`, ''];
    for (const path of paths) {
        for (const suffix of suffixes) {
            const message = `${ts}\n${signedMethod}\n${path}\n${ncUid}${suffix}`;
            const expected = crypto.createHmac('sha256', config.tenantKey).update(message).digest();
            if (crypto.timingSafeEqual(expected, sigBuf)) return true;
        }
    }
    return false;
}

function buildNcProxy() {
    const isHttps = String(config.nextcloudUrl || '').startsWith('https://');
    return createProxyMiddleware({
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
                // (express.raw, mounted in mount() below), so replay the exact
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
                console.error(`[NcProxy] ${req.method} ${req.url}: ${err.message}`);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Nextcloud is unreachable from the connector' });
                }
            },
        },
    });
}

function mount(app) {
    const proxy = buildNcProxy();
    // Buffer the body as raw bytes for every content type. Two reasons: the
    // HMAC covers sha256(body), and WebDAV uploads must reach Nextcloud
    // byte-for-byte. The limit matches what the global JSON parser used to
    // impose on this path, plus headroom for file uploads.
    const rawBody = express.raw({ type: () => true, limit: '100mb' });
    app.use('/nc', rawBody, (req, res, next) => {
        // Allowed-prefix check after pathRewrite would happen too late; do it here.
        const stripped = req.url.split('?')[0];
        if (!ALLOWED_PREFIXES.some(p => stripped.startsWith(p))) {
            return res.status(404).json({ error: 'Path not proxied' });
        }
        if (!verifyHmac(req)) {
            return res.status(401).json({ error: 'Missing or invalid X-Beeflow-Sig' });
        }
        // Restore the real WebDAV method from the tunnel BEFORE http-proxy builds
        // the upstream request (changing proxyReq.method later is too late — the
        // method is fixed when the ClientRequest is created). The signature was
        // verified over this real method above, so this can't bypass auth.
        const override = req.headers['x-http-method-override'];
        if (override) {
            req.method = String(override).toUpperCase();
            delete req.headers['x-http-method-override'];
        }
        return proxy(req, res, next);
    });
}

module.exports = { mount, verifyHmac };
