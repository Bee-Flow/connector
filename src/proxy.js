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
        // Strip the /api prefix that the SPA uses locally; the SaaS expects
        // it too, so this is identity for now — kept explicit so swapping the
        // SaaS path layout doesn't require touching the SPA.
        pathRewrite: { '^/api': '/api' },
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
                // Forward the original NC user id for SaaS-side auditing.
                if (req.beeflow?.user?.uid) {
                    proxyReq.setHeader('X-Beeflow-Source', 'nextcloud-connector');
                    proxyReq.setHeader('X-Beeflow-NC-Uid', req.beeflow.user.uid);
                }
                if (req.body) fixRequestBody(proxyReq, req);
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
