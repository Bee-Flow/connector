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

// How long the SaaS may take to send RESPONSE HEADERS before we give up.
// Deliberately not a whole-request timeout: an SSE chat turn legitimately
// streams for minutes, and the headers arrive within the first moment. Once
// they do, the timer is cleared and the body streams for as long as it needs.
// Without this a SaaS that accepts the socket and never answers left the
// browser hanging forever on a request that shows no error anywhere.
const RESPONSE_HEADERS_TIMEOUT_MS = parseInt(
    process.env.BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS || '60000', 10);

// Requests whose body express.json() has already consumed and parsed. Only
// those may be re-serialised by fixRequestBody.
//
// express.json() assigns `req.body = {}` BEFORE it checks the content-type
// (body-parser: `req.body = req.body || {}` precedes `shouldParse`), so a
// multipart/form-data upload arrives here with a TRUTHY-but-empty req.body
// while its raw stream is still unread. The old `if (req.body)` guard
// therefore handed uploads to fixRequestBody too, whose multipart branch
// re-encodes `{}` into an empty document.
//
// Measured against the pinned http-proxy-middleware the upload still survives
// (fixRequestBody bails while req.readableLength is non-zero, and the piped
// body wins even when it is zero) — so this is a latent hazard rather than an
// observed bug. Gating on the content-type express.json() actually parses
// makes correctness ours instead of a transitive dependency's internals.
// test/chatStream.regression.test.js pins the behaviour either way.
function hasParsedJsonBody(req) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return false;
    return !!req.body && typeof req.body === 'object';
}

// Keep-alive agents WITH stale-socket failover. Keep-alive matters here:
// with it off, every asset and API call on an embedded page load pays a
// fresh TCP+TLS handshake to the cloud (~30 handshakes per cold load — a
// measurable chunk of the "Bee Flow is slow inside Nextcloud" complaint).
//
// The reason it used to be off is real, though: pooled sockets go stale
// when the upstream container gets a new IP (compose restart, rolling
// deploy, k8s pod rotation) and the peer dies without a FIN — the next
// request on that socket fails ECONNRESET/EPIPE. The failover below keeps
// the reliability property without the per-request handshake tax:
//   1. on a network-class proxy error, destroy the agent's FREE sockets
//      (never in-flight ones — a live SSE chat stream must survive another
//      request's failure), so the next connect re-resolves DNS;
//   2. retry the request once, GET/HEAD only (no body to replay), via the
//      same middleware — the retry grabs a fresh socket.
// Non-idempotent requests still surface the 502; their free-socket purge
// means the client's own retry lands on a clean pool.
const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 64, maxFreeSockets: 8 };
const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent(AGENT_OPTS);

// Network-class errors where the socket/pool is suspect. Anything else
// (protocol errors, aborts) is not a stale-pool symptom and never retried.
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN',
]);

function dropFreeSockets(agent) {
    for (const list of Object.values(agent.freeSockets || {})) {
        for (const socket of [...list]) {
            try { socket.destroy(); } catch (_) { /* already gone */ }
        }
    }
}

// Shared failover: purge the free pool and, for idempotent requests that
// haven't sent headers yet, re-dispatch through the middleware exactly once.
// Returns true when a retry was dispatched (caller must not respond).
function retryOnceOnNetworkError({ err, req, res, agent, middleware, onExhausted }) {
    if (!NETWORK_ERROR_CODES.has(err.code)) return false;
    dropFreeSockets(agent);
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    if (!idempotent || res.headersSent || req.__beeflowRetried) return false;
    req.__beeflowRetried = true;
    middleware(req, res, onExhausted);
    return true;
}

// The SPA "shell" — index.html + hashed /assets + logos/favicon — is the
// subset of connector-owned paths that make up the front-end bundle. These
// are proxied to the cloud `/embed/` build (buildEmbedProxy). The connector-
// LOCAL paths (/setup, /js/embed, /img/app.svg) are handled by their own
// routes in server.js and never reach the shell proxy; client-side SPA routes
// (e.g. /agents) are NOT shell paths and stay proxied to the SaaS API.
const SPA_SHELL = /^\/(assets\/|js\/|img\/|favicon|app-icon\.svg$|BeeFlow-logo|bee-flow-logo|index\.html$|$)/;

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
    const agent = isHttps ? httpsAgent : httpAgent;
    let mw; // self-reference for the one-shot retry in the error handler
    mw = createProxyMiddleware({
        target: config.apiBaseUrl,
        changeOrigin: true,
        agent,
        // Critical for SSE on the chat endpoint — disables proxy buffering.
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.removeHeader('cookie');
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');

                // Never let the connector→SaaS hop be compressed.
                //
                // The browser's `Accept-Encoding: gzip, deflate, br` is copied
                // onto this request verbatim, so any compressing hop in front
                // of the SaaS may gzip the SSE chat stream. This proxy cannot
                // decompress it (it pipes bytes through untouched), and the
                // response half used to DELETE the `Content-Encoding` header —
                // which handed the browser gzip bytes labelled `text/event-
                // stream`. The SSE reader then matched zero `data:` lines and
                // rendered a blank assistant reply with no error at all.
                //
                // This hop is connector→SaaS over the operator's own network,
                // where compression buys almost nothing, so asking for
                // identity removes the whole failure mode at the source. The
                // browser→Nextcloud hop still compresses normally.
                proxyReq.setHeader('accept-encoding', 'identity');

                // A parsed body has to be re-serialised (below), which means
                // this request gets a Content-Length. Drop any inherited
                // chunked framing first: http-proxy copies the inbound headers
                // onto the outbound request, so `Transfer-Encoding: chunked` +
                // fixRequestBody's `Content-Length` produced a message framed
                // BOTH ways. RFC 9112 §6.1 requires rejecting that, and Node
                // does — 400, route handler never invoked. Nextcloud's AppAPI
                // proxy makes this the normal case, not an edge case: it drops
                // content-length from the forwarded headers
                // (ExAppProxyController::buildHeadersWithExclude) and streams
                // php://input through Guzzle, which then frames it chunked.
                if (hasParsedJsonBody(req)) proxyReq.removeHeader('transfer-encoding');

                // Give up if the SaaS never sends response headers. Cleared in
                // proxyRes, so a long SSE body is unaffected.
                proxyReq.setTimeout(RESPONSE_HEADERS_TIMEOUT_MS, () => {
                    proxyReq.destroy(new Error(
                        `upstream sent no response headers within ${RESPONSE_HEADERS_TIMEOUT_MS}ms`));
                });

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

                // Nextcloud's AppAPI has no PATCH proxy route at all — its
                // routes.php only registers ExAppGet/Post/Put/Delete and
                // AppAPIService::requestToExAppInternal's match() has no
                // 'PATCH' arm. So the SPA sends PATCH as POST plus this
                // header when it runs inside Nextcloud; restore the real
                // method here, before the SaaS sees it.
                const override = req.headers['x-http-method-override'];
                if (override && req.method === 'POST') {
                    const verb = String(override).toUpperCase();
                    if (verb === 'PATCH') {
                        proxyReq.method = verb;
                        proxyReq.removeHeader('x-http-method-override');
                    }
                }

                if (hasParsedJsonBody(req)) fixRequestBody(proxyReq, req);
            },
            proxyRes: (proxyRes, req, res) => {
                // Headers arrived — the connect-phase timer has done its job.
                // Anything after this point is body streaming, which must be
                // allowed to take as long as the model needs. proxyRes.req is
                // the OUTBOUND request the timer was armed on.
                try { proxyRes.req?.setTimeout?.(0); } catch (_) { /* best effort */ }
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

                    // NOTE: `content-encoding` is deliberately NOT touched here.
                    // Deleting it while forwarding the bytes untouched is what
                    // turned a compressed stream into binary garbage labelled
                    // `text/event-stream` — a 200 whose body yields zero SSE
                    // events, i.e. a blank assistant reply with no error. The
                    // request half now asks the SaaS for `identity`, so a
                    // compressed SSE body should not arise at all; if one still
                    // does, forwarding its header intact lets the browser
                    // decode it correctly instead of silently corrupting it.

                    if (process.env.HP_SHARED_KEY) {
                        // HaRP mode: the connector is reached over the HaRP
                        // tunnel rather than through PHP's fpassthru, so the
                        // re-chunking worked around below does not apply here.
                        // Let normal chunked streaming through and keep the
                        // connection alive — close-framing would needlessly
                        // tear down the tunnel socket once per stream.
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
                console.error(`[Proxy] ${req.method} ${req.url}: ${err.message}${req.__beeflowRetried ? ' (after retry)' : ''}`);
                const respond502 = () => {
                    if (!res.headersSent) {
                        res.status(502).json({
                            error: 'Bee Flow service is temporarily unavailable. Please try again.',
                        });
                    }
                };
                if (retryOnceOnNetworkError({ err, req, res, agent, middleware: mw, onExhausted: respond502 })) {
                    console.warn(`[Proxy] retrying ${req.method} ${req.url} on a fresh socket (${err.code})`);
                    return;
                }
                respond502();
            },
        },
    });
    return mw;
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
    const agent = isHttps ? httpsAgent : httpAgent;
    let mw; // self-reference for the one-shot retry in the error handler
    mw = createProxyMiddleware({
        target: config.embedBaseUrl,
        changeOrigin: true,
        agent,
        pathRewrite: rewriteToEmbed,
        on: {
            proxyReq: (proxyReq) => {
                // These belong to Nextcloud, not the cloud frontend host.
                proxyReq.removeHeader('cookie');
                proxyReq.removeHeader('origin');
                proxyReq.removeHeader('referer');
            },
            error: (err, req, res) => {
                // Retry once on a fresh socket, then fall through to the
                // baked /public bundle rather than 502 (shell requests are
                // all GET, so every one qualifies for the retry).
                const fallback = () => {
                    console.warn(`[EmbedProxy] ${req.method} ${req.url}: ${err.message} — falling back to baked /public`);
                    if (!res.headersSent && typeof req.__shellNext === 'function') {
                        return req.__shellNext();
                    }
                    if (!res.headersSent) {
                        res.status(502).json({ error: 'Bee Flow UI is temporarily unavailable. Please try again.' });
                    }
                };
                if (retryOnceOnNetworkError({ err, req, res, agent, middleware: mw, onExhausted: fallback })) {
                    console.warn(`[EmbedProxy] retrying ${req.method} ${req.url} on a fresh socket (${err.code})`);
                    return;
                }
                fallback();
            },
        },
    });
    return mw;
}

module.exports = { buildApiProxy, buildEmbedProxy, isSpaShellPath, rewriteToEmbed };
