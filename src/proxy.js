/**
 * /api/* forward proxy → hosted Bee Flow SaaS.
 *
 * The auth middleware has already minted req.beeflow.jwt by the time we get
 * here. We strip cookies (they belong to Nextcloud, not us) and inject the
 * JWT as a bearer. Streams pass through unchanged so the SSE chat endpoint
 * works without buffering.
 */

const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const http = require('http');
const https = require('https');
const config = require('./config');

// Custom agents with keep-alive disabled. http-proxy-middleware (and Node's
// default Agent) cache TCP sockets per host; when the upstream container
// gets a new IP (compose restart, rolling deploy, k8s pod rotation), the
// cached socket points at the dead old IP and every request fails with
// ECONNREFUSED until the connector is restarted manually. Forcing a fresh
// connection per request guarantees DNS re-resolution and eliminates that
// failure mode entirely. The throughput cost is negligible for a single-NC
// connector and is the right trade-off for reliability.
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// The SPA "shell" — index.html + hashed /assets + logos/favicon — is the
// subset of connector-owned paths that make up the front-end bundle. These
// are proxied to the cloud `/embed/` build (buildEmbedProxy). The connector-
// LOCAL paths (/setup, /js/embed, /img/app.svg) are handled by their own
// routes in server.js and never reach the shell proxy; client-side SPA routes
// (e.g. /agents) are NOT shell paths and stay proxied to the SaaS API.
const SPA_SHELL = /^\/(assets\/|js\/|img\/|favicon|BeeFlow-logo|bee-flow-logo|index\.html$|$)/;

function isSpaShellPath(urlPath) {
    return SPA_SHELL.test(String(urlPath).split('?')[0]);
}

// Map a connector-local shell path onto the cloud's `/embed/` storage prefix:
// `/` → `/embed/`, `/assets/x.js` → `/embed/assets/x.js`.
function rewriteToEmbed(p) {
    return '/embed' + p;
}

function buildApiProxy() {
    const isHttps = String(config.apiBaseUrl || '').startsWith('https://');
    return createProxyMiddleware({
        target: config.apiBaseUrl,
        changeOrigin: true,
        agent: isHttps ? httpsAgent : httpAgent,
        // Critical for SSE on the chat endpoint — disables proxy buffering.
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.removeHeader('cookie');
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');
                if (req.beeflow?.jwt) {
                    proxyReq.setHeader('Authorization', `Bearer ${req.beeflow.jwt}`);
                }
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
                    // Universally safe: disable intermediary buffering for SSE.
                    proxyRes.headers['x-accel-buffering'] = 'no';
                    proxyRes.headers['cache-control'] = 'no-cache, no-transform';

                    if (process.env.HP_SHARED_KEY) {
                        // HaRP mode: the stream is browser → HAProxy → unix
                        // socket — NC's PHP ExAppProxyController is NOT in the
                        // path, so the double-chunking described below can't
                        // happen. Let normal chunked streaming through and keep
                        // the connection alive (close-framing would needlessly
                        // tear down the tunnel socket per stream). Just drop a
                        // stale content-encoding if the upstream set one.
                        delete proxyRes.headers['content-encoding'];
                    } else {
                        // Manual / Docker-Socket-Proxy mode: NC's AppAPI proxy
                        // (apps/app_api/lib/Controller/ExAppProxyController.php)
                        // strips `Transfer-Encoding: chunked` unconditionally.
                        // PHP/Apache then re-adds chunked encoding to a body
                        // whose payload already contains the upstream chunk-size
                        // hex headers, double-chunking the stream → Chrome aborts
                        // with ERR_INVALID_CHUNKED_ENCODING.
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
                        delete proxyRes.headers['content-length'];
                        delete proxyRes.headers['content-encoding'];
                        delete proxyRes.headers['transfer-encoding'];
                        proxyRes.headers['connection'] = 'close';
                        if (res) {
                            res.useChunkedEncodingByDefault = false;
                            res.shouldKeepAlive = false;
                        }
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

// Proxy for the embedded SPA SHELL (index.html + hashed /assets, logos,
// favicon). The shell used to be baked into this image at /public; we now
// fetch it from the cloud frontend's `/embed/` build so a frontend deploy
// reaches the embedded view without a connector release. The SPA itself is
// still built with --base=/index.php/apps/app_api/proxy/<appId>/, so every
// asset + API URL the browser resolves routes back through NC → connector —
// only the bytes' origin moves from /public to the cloud.
//
// pathRewrite prepends `/embed`: the connector sees the NC-proxy-stripped
// path (`/`, `/assets/x.js`, `/bee-flow-logo.png`) and maps it onto the
// cloud's `/embed/` storage prefix (`/embed/`, `/embed/assets/x.js`, …).
//
// On ANY upstream error (cloud unreachable, 5xx) the handler calls the
// captured `next()` so the request falls through to the retained
// express.static(/public) + baked index.html — the offline fallback. We
// stash next on req.__shellNext because http-proxy-middleware's error hook
// doesn't receive it.
function buildEmbedProxy() {
    const isHttps = String(config.embedBaseUrl || '').startsWith('https://');
    return createProxyMiddleware({
        target: config.embedBaseUrl,
        changeOrigin: true,
        agent: isHttps ? httpsAgent : httpAgent,
        pathRewrite: rewriteToEmbed,
        on: {
            proxyReq: (proxyReq) => {
                // These belong to Nextcloud, not the cloud frontend host.
                proxyReq.removeHeader('cookie');
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');
            },
            error: (err, req, res) => {
                // Fall through to the baked /public bundle rather than 502.
                console.warn(`[EmbedProxy] ${req.method} ${req.url}: ${err.message} — falling back to baked /public`);
                if (!res.headersSent && typeof req.__shellNext === 'function') {
                    return req.__shellNext();
                }
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Bee Flow UI is temporarily unavailable. Please try again.' });
                }
            },
        },
    });
}

module.exports = { buildApiProxy, buildEmbedProxy, isSpaShellPath, rewriteToEmbed };
