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
            proxyRes: (proxyRes, req, res) => {
                // SSE pass-through.
                //
                // NC's AppAPI proxy (apps/app_api/lib/Controller/
                // ExAppProxyController.php:80-83) strips
                // `Transfer-Encoding: chunked` unconditionally. PHP/Apache
                // then re-adds chunked encoding to a body whose payload
                // already contains the upstream chunk-size hex headers,
                // double-chunking the stream → Chrome aborts with
                // ERR_INVALID_CHUNKED_ENCODING.
                //
                // Fix: emit the connector→NC response with HTTP/1.1
                // connection-close framing — no Content-Length, no
                // Transfer-Encoding header at all. NC's strip predicate
                // checks `isset($responseHeaders['Transfer-Encoding'])`
                // first, so an absent header is a no-op and the body is
                // forwarded as raw bytes via fpassthru. Apache then adds
                // the single, well-formed chunked encoding the browser
                // actually receives. EventSource parses correctly.
                //
                // Mechanics: setting `useChunkedEncodingByDefault = false`
                // on Node's ServerResponse stops Node from auto-adding
                // `Transfer-Encoding: chunked` when a body is written
                // without Content-Length. With `Connection: close` and no
                // length headers, the message is framed by socket-close
                // (RFC 9112 §6.3). The flag is undocumented but stable
                // across Node 16-22; tested in this environment.
                const ct = proxyRes.headers['content-type'] || '';
                if (ct.startsWith('text/event-stream')) {
                    proxyRes.headers['x-accel-buffering'] = 'no';
                    proxyRes.headers['cache-control'] = 'no-cache, no-transform';
                    delete proxyRes.headers['content-length'];
                    delete proxyRes.headers['content-encoding'];
                    delete proxyRes.headers['transfer-encoding'];
                    proxyRes.headers['connection'] = 'close';
                    if (res) {
                        res.useChunkedEncodingByDefault = false;
                        res.shouldKeepAlive = false;
                    }
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
