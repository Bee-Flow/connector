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
 * Inbound auth check: the SaaS authenticates to the connector with HMAC of
 * (timestamp + path + body) using the tenant key. Anyone else hitting /nc/*
 * gets 401. Without this, a malicious SPA could call /nc/* directly and
 * impersonate any NC user.
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

const ALLOWED_PREFIXES = ['/ocs/', '/remote.php/dav/', '/index.php/apps/'];

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
    const path = req.originalUrl || req.url;
    // WebDAV methods are tunnelled over POST + X-HTTP-Method-Override (NC's
    // AppAPI proxy rejects raw PROPFIND/REPORT/… with 405). The SaaS signs the
    // HMAC over the REAL method, so verify against the override when present —
    // this also means the override can't be swapped without invalidating the
    // signature.
    const signedMethod = String(req.headers['x-http-method-override'] || req.method).toUpperCase();
    const message = `${ts}\n${signedMethod}\n${path}\n${ncUid}`;
    const expected = crypto.createHmac('sha256', config.tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
        return false;
    }
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
    app.use('/nc', (req, res, next) => {
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
