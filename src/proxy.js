/**
 * /api/* forward proxy → hosted Bee Flow SaaS.
 *
 * The auth middleware has already minted req.beeflow.jwt by the time we get
 * here. We strip cookies (they belong to Nextcloud, not us) and inject the
 * JWT as a bearer. Streams pass through unchanged so the SSE chat endpoint
 * works without buffering.
 */

const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const config = require('./config');

function buildApiProxy() {
    return createProxyMiddleware({
        target: config.apiBaseUrl,
        changeOrigin: true,
        // Critical for SSE on the chat endpoint — disables proxy buffering.
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq, req) => {
                if (req.beeflow?.jwt) {
                    proxyReq.setHeader('Authorization', `Bearer ${req.beeflow.jwt}`);
                }
                // Cookies are scoped to the Nextcloud origin — they have no
                // meaning to our SaaS and may carry session tokens that
                // shouldn't leave the customer's perimeter.
                proxyReq.removeHeader('cookie');
                // Origin/Referer reflect the browser's view of NC, not our
                // server-to-server call. The SaaS's CORS middleware rejects
                // unknown browser origins; X-Beeflow-Source is the trust
                // signal for this code path. Strip both so CORS treats this
                // as a same-origin call.
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');
                // Forward the original NC user id for SaaS-side auditing.
                if (req.beeflow?.user?.uid) {
                    proxyReq.setHeader('X-Beeflow-Source', 'nextcloud-connector');
                    proxyReq.setHeader('X-Beeflow-NC-Uid', req.beeflow.user.uid);
                }
                // Instance-id binding so the SaaS can resolve the right org
                // without a per-request OCS lookup. nc_instance_id is set
                // during bootstrap and cached in config.
                if (config.ncInstanceId) {
                    proxyReq.setHeader('X-Beeflow-NC-Instance-Id', config.ncInstanceId);
                }
                proxyReq.setHeader('X-Beeflow-NC-Base-Url', config.nextcloudUrl);
                if (req.body) fixRequestBody(proxyReq, req);
            },
            proxyRes: (proxyRes) => {
                // SSE pass-through. NC's PHP-proxy + HaRP's HAProxy honour
                // X-Accel-Buffering=no and won't buffer chunked responses,
                // but only if the *response* itself doesn't carry a
                // Content-Length header (chunked encoding is required for
                // streaming). Strip it on text/event-stream so the upstream
                // proxies forward chunks immediately.
                const ct = proxyRes.headers['content-type'] || '';
                if (ct.startsWith('text/event-stream')) {
                    proxyRes.headers['x-accel-buffering'] = 'no';
                    proxyRes.headers['cache-control'] = 'no-cache, no-transform';
                    delete proxyRes.headers['content-length'];
                    delete proxyRes.headers['content-encoding'];
                }
            },
            error: (err, req, res) => {
                console.error(`[Proxy] ${req.method} ${req.url}: ${err.message}`);
                if (!res.headersSent) {
                    res.status(502).json({
                        error: 'Bee Flow service is temporarily unavailable. Please try again.',
                    });
                }
            },
        },
    });
}

module.exports = { buildApiProxy };
