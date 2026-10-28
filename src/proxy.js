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
const log = require('./log');
const { errMessage } = require('./errors');
const { isExpressResponse } = require('./httpGuards');
const { shellBaseUrl } = require('./embedTarget');

// How long the SaaS may take to send RESPONSE HEADERS before we give up.
// Deliberately not a whole-request timeout: an SSE chat turn legitimately
// streams for minutes, and the headers arrive within the first moment. Once
// they do, the timer is cleared and the body streams for as long as it needs.
// Without this a SaaS that accepts the socket and never answers left the
// browser hanging forever on a request that shows no error anywhere.
//
// The clock starts when the request reaches the proxy, not when a socket is
// assigned: a request waiting in the agent queue for a free socket counts too.
// 0 switches the timeout off.
const RESPONSE_HEADERS_TIMEOUT_MS = parseInt(
    process.env.BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS || '60000', 10);

// Sockets per upstream origin. 0 (the default) = no cap. A cap is a shared
// queue for every user of this Nextcloud: chat turns, project and document
// streams each hold a socket for minutes, so 64 of them used to leave every
// other request (a click, /api/health) waiting in the agent queue forever.
const UPSTREAM_MAX_SOCKETS = parseInt(process.env.BEEFLOW_UPSTREAM_MAX_SOCKETS || '0', 10);

// Request headers that may travel from the browser (via Nextcloud's AppAPI
// proxy or HaRP) to the Bee Flow server. An ALLOW-list on purpose: AppAPI adds
// `AUTHORIZATION-APP-API` (base64 "<uid>:<APP_SECRET>", the key that lets
// anyone act as any Nextcloud user), `EX-APP-ID`, `AA-VERSION` and friends to
// every request it hands us, and http-proxy copies every inbound header onto
// the outbound request. A deny-list leaks whatever header AppAPI, HaRP or a
// reverse proxy adds next year; an allow-list cannot. The connector sets its
// own Authorization, X-Beeflow-* and Accept-Encoding after filtering.
const API_REQUEST_HEADERS = new Set([
    'accept', 'accept-language', 'user-agent', 'cache-control', 'pragma',
    'content-type', 'content-length', 'content-encoding', 'content-language',
    'content-disposition', 'content-range', 'transfer-encoding',
    'range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
    'last-event-id', 'x-http-method-override', 'x-requested-with',
    // The embedded app's own headers. x-session-token carries the session a
    // sign-in popup handed to the iframe (server/boot/session.js); without it
    // every request after such a sign-in is anonymous.
    'x-session-token', 'x-beeflow-client', 'x-request-id',
]);

// The SPA shell is static: index.html, hashed assets, fonts. It needs the
// cache validators and nothing that identifies the user.
const SHELL_REQUEST_HEADERS = new Set([
    'accept', 'accept-language', 'user-agent', 'cache-control', 'pragma',
    'range', 'if-range', 'if-none-match', 'if-modified-since',
]);

/**
 * Replace the inbound headers with the allow-listed subset. Done on
 * `req.headers` itself, before http-proxy builds the outbound request: its
 * `proxyReq` hook is skipped entirely when the request carries `Expect`
 * (Guzzle sends `Expect: 100-continue` for larger bodies), so filtering there
 * would let exactly those requests through unfiltered.
 * @param {import('http').IncomingMessage} req
 * @param {Set<string>} allowed
 * @param {Record<string, string>} set  headers the connector adds itself
 */
function rewriteRequestHeaders(req, allowed, set) {
    /** @type {import('http').IncomingHttpHeaders} */
    const out = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (allowed.has(name) && value !== undefined) out[name] = value;
    }
    for (const [name, value] of Object.entries(set)) out[name] = value;
    req.headers = out;
}

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
/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
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
const AGENT_OPTS = {
    keepAlive: true, keepAliveMsecs: 10_000, maxFreeSockets: 8,
    maxSockets: UPSTREAM_MAX_SOCKETS > 0 ? UPSTREAM_MAX_SOCKETS : Infinity,
};
const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent(AGENT_OPTS);

// Network-class errors where the socket/pool is suspect. Anything else
// (protocol errors, aborts) is not a stale-pool symptom and never retried.
/** @typedef {import('http-proxy-middleware').RequestHandler<import('express').Request, import('express').Response>} ProxyHandler */
/** @typedef {import('http-proxy-middleware').Options<import('express').Request, import('express').Response>} ProxyOptions */

const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN',
]);

/** @param {http.Agent} agent */
function dropFreeSockets(agent) {
    for (const list of Object.values(agent.freeSockets || {})) {
        for (const socket of [...(list || [])]) {
            try { socket.destroy(); } catch (_) { /* already gone */ }
        }
    }
}

// Shared failover: purge the free pool and, for idempotent requests that
// haven't sent headers yet, re-dispatch through the middleware exactly once.
// Returns true when a retry was dispatched (caller must not respond).
/**
 * @param {object} args
 * @param {Error} args.err
 * @param {import('express').Request} args.req
 * @param {import('express').Response} args.res
 * @param {http.Agent} args.agent
 * @param {ProxyHandler} args.middleware  the proxy to run the request through again
 * @param {() => void} args.onExhausted  what to do when the request is not retried
 * @returns {boolean} true when the request went round again
 */
function retryOnceOnNetworkError({ err, req, res, agent, middleware, onExhausted }) {
    if (!err.code || !NETWORK_ERROR_CODES.has(err.code)) return false;
    dropFreeSockets(agent);
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    if (!idempotent || res.headersSent || req.__beeflowRetried) return false;
    req.__beeflowRetried = true;
    middleware(req, res, onExhausted);
    return true;
}

// The SPA "shell" — index.html + hashed /assets + logos/favicon, plus the
// static folders the build copies next to them (/fonts, /module-shims for the
// Studio app runtime, /monaco for the code editor) — is the
// subset of connector-owned paths that make up the front-end bundle. These
// are proxied to the cloud `/embed/` build (buildEmbedProxy). The connector-
// LOCAL paths (/setup, /js/embed, /img/app.svg) are handled by their own
// routes in server.js and never reach the shell proxy; client-side SPA routes
// (e.g. /agents) are NOT shell paths and stay proxied to the SaaS API.
const SPA_SHELL = /^\/(assets\/|js\/|img\/|fonts\/|module-shims\/|monaco\/|favicon|app-icon\.svg$|n8n-color\.png$|BeeFlow-logo|bee-flow-logo|index\.html$|$)/;

/** @param {string} urlPath */
function isSpaShellPath(urlPath) {
    return SPA_SHELL.test(String(urlPath).split('?')[0]);
}

// Map a connector-local shell path onto the cloud's `/embed/` storage prefix:
// `/` → `/embed/`, `/assets/x.js` → `/embed/assets/x.js`.
/** @param {string} p */
function rewriteToEmbed(p) {
    return '/embed' + p;
}

/**
 * Arm the response-headers timeout on the INCOMING request, so time spent
 * waiting for a pooled socket counts. http-proxy only emits `proxyReq` once a
 * socket is assigned; a timer armed there never fires for a request that is
 * still queued.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} label
 */
function armHeadersTimeout(req, res, label) {
    if (!(RESPONSE_HEADERS_TIMEOUT_MS > 0)) return;
    const timer = setTimeout(() => {
        const err = new Error(`upstream sent no response headers within ${RESPONSE_HEADERS_TIMEOUT_MS}ms`);
        const pending = req.__beeflowProxyReq;
        // On a socket: abort it, the proxy's error hook answers 502.
        if (pending && !pending.destroyed) { pending.destroy(err); return; }
        // Still queued for a socket: answer now and drop the request when it
        // finally gets one (see the proxyReq hook).
        req.__beeflowTimedOut = true;
        log.error(`[${label}] ${req.method} ${req.url}: ${err.message} (no upstream socket)`);
        if (!res.headersSent) {
            res.statusCode = 504;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Bee Flow service did not answer in time. Please try again.' }));
        }
    }, RESPONSE_HEADERS_TIMEOUT_MS);
    timer.unref?.();
    req.__beeflowHeadersTimer = timer;
    res.on('close', () => clearTimeout(timer));
}

/**
 * Remember the outbound request for the headers timeout; drop it at once when
 * the timeout already answered while it waited for a socket.
 * @param {import('http').ClientRequest} proxyReq
 * @param {import('http').IncomingMessage} req
 * @returns {boolean} false when the request was dropped
 */
function trackProxyReq(proxyReq, req) {
    req.__beeflowProxyReq = proxyReq;
    if (req.__beeflowTimedOut) { proxyReq.destroy(); return false; }
    return true;
}

/**
 * One proxy per target URL, built on first use. The target is read from
 * config on every request: `/setup`, the admin settings form and the boot-time
 * pin all change `config.apiBaseUrl` at runtime, and a proxy built once at
 * boot kept sending the SPA's traffic to the old server (signed with the new
 * server's tenant key, so every call failed until a restart).
 * @param {(target: string) => ProxyHandler} build
 * @returns {(target: string) => ProxyHandler}
 */
function perTarget(build) {
    /** @type {Map<string, ProxyHandler>} */
    const byTarget = new Map();
    return (target) => {
        let mw = byTarget.get(target);
        if (!mw) { mw = build(target); byTarget.set(target, mw); }
        return mw;
    };
}

/** @param {string} target */
function agentFor(target) {
    return String(target || '').startsWith('https://') ? httpsAgent : httpAgent;
}

/**
 * The headers the Bee Flow server gets for a request from the SPA: the
 * allow-listed browser headers plus what the connector vouches for.
 * @param {import('express').Request} req
 */
function apiRequestHeaders(req) {
    /** @type {Record<string, string>} */
    const set = {
        // Never let the connector→SaaS hop be compressed.
        //
        // The browser's `Accept-Encoding: gzip, deflate, br` used to be copied
        // onto this request verbatim, so any compressing hop in front of the
        // SaaS could gzip the SSE chat stream. This proxy cannot decompress it
        // (it pipes bytes through untouched), and the response half used to
        // DELETE the `Content-Encoding` header — which handed the browser gzip
        // bytes labelled `text/event-stream`: a blank assistant reply with no
        // error at all. This hop is connector→SaaS over the operator's own
        // network, where compression buys almost nothing; the
        // browser→Nextcloud hop still compresses normally.
        'accept-encoding': 'identity',
        'x-beeflow-nc-base-url': config.nextcloudUrl,
    };
    if (req.beeflow?.jwt) set.authorization = `Bearer ${req.beeflow.jwt}`;
    if (req.beeflow?.user?.uid) {
        set['x-beeflow-source'] = 'nextcloud-connector';
        set['x-beeflow-nc-uid'] = req.beeflow.user.uid;
    }
    // Instance-id binding so the SaaS can resolve the right org without a
    // per-request OCS lookup. nc_instance_id is set during bootstrap.
    if (config.ncInstanceId) set['x-beeflow-nc-instance-id'] = config.ncInstanceId;
    return set;
}

function buildApiProxy() {
    const proxyFor = perTarget(buildApiProxyFor);
    /** @type {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown} */
    return (req, res, next) => {
        rewriteRequestHeaders(req, API_REQUEST_HEADERS, apiRequestHeaders(req));
        armHeadersTimeout(req, res, 'Proxy');
        return proxyFor(config.apiBaseUrl)(req, res, next);
    };
}

/** @param {string} target */
function buildApiProxyFor(target) {
    const agent = agentFor(target);
    /** @type {ProxyOptions} */
    const options = {
        target,
        changeOrigin: true,
        agent,
        // Critical for SSE on the chat endpoint — disables proxy buffering.
        selfHandleResponse: false,
        on: {
            proxyReq: (proxyReq, req) => {
                if (!trackProxyReq(proxyReq, req)) return;

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
                // Headers arrived — the headers timer has done its job.
                // Anything after this point is body streaming, which must be
                // allowed to take as long as the model needs.
                clearTimeout(req.__beeflowHeadersTimer);
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
                if (!isExpressResponse(res)) return;
                log.error(`[Proxy] ${req.method} ${req.url}: ${errMessage(err)}${req.__beeflowRetried ? ' (after retry)' : ''}`);
                const respond502 = () => {
                    if (!res.headersSent) {
                        res.status(502).json({
                            error: 'Bee Flow service is temporarily unavailable. Please try again.',
                        });
                    }
                };
                if (retryOnceOnNetworkError({ err, req, res, agent, middleware: mw, onExhausted: respond502 })) {
                    log.warn(`[Proxy] retrying ${req.method} ${req.url} on a fresh socket (${err.code})`);
                    return;
                }
                respond502();
            },
        },
    };
    /** @type {ProxyHandler} */
    const mw = createProxyMiddleware(options); // the error handler above reaches it for the one-shot retry
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
// When the cloud is unreachable, answers 5xx, or has no index.html (404 on
// `/` or `/index.html`), the handler calls the captured `next()` so the
// request falls through to the retained express.static(/public) + baked
// index.html — the offline fallback. We stash next on req.__shellNext
// because http-proxy-middleware's hooks don't receive it. The response is
// self-handled for that reason: the status must be seen before anything is
// written to the browser.

// Hop-by-hop headers (RFC 9110 §7.6.1) and cookies: never copied from the
// shell host's answer onto ours. A cookie for beeflow.nl has no business on
// the Nextcloud origin.
const SHELL_RESPONSE_DROP = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
    'set-cookie',
]);

/**
 * A `..` segment in the path, also percent-encoded (once or twice). Such a
 * shell path would leave the `/embed/` prefix on the frontend host once that
 * host normalises it, and whatever it named would be served under the
 * Nextcloud origin. AppAPI refuses `..` itself; HaRP and a direct call on the
 * docker network may not.
 * @param {string} url
 */
function hasTraversal(url) {
    let p = String(url).split('?')[0];
    for (let i = 0; i < 3; i++) {
        if (p.replace(/\\/g, '/').split('/').some((seg) => seg === '..' || seg === '.')) return true;
        let next;
        try { next = decodeURIComponent(p); } catch { return true; }
        if (next === p) return false;
        p = next;
    }
    return true;
}

/** @param {string} url */
function isShellDocument(url) {
    const p = String(url).split('?')[0];
    return p === '/' || p === '/index.html';
}

/**
 * Whether an upstream answer should be replaced by the baked shell.
 * @param {number} status
 * @param {string} url  the connector-local path
 */
function shouldFallBack(status, url) {
    return status >= 500 || (status === 404 && isShellDocument(url));
}

function buildEmbedProxy() {
    const proxyFor = perTarget(buildEmbedProxyFor);
    /** @type {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown} */
    return (req, res, next) => {
        if (hasTraversal(req.url)) return next(); // the baked bundle; express.static refuses traversal itself
        // Per request: the shell host follows the live server choice (#401).
        // null = a self-hosted server without a web app URL, which gets the
        // baked shell rather than Cloud's frontend.
        const target = shellBaseUrl();
        if (!target) return next();
        // Never let the shell hop be compressed either. Nextcloud's AppAPI
        // proxy copies the browser's `Accept-Encoding: gzip` onto its request
        // to us, the frontend host gzips text/html, and we pipe the bytes
        // through. For HTML AppAPI does NOT stream: it buffers, decodes the
        // gzip (the reply carries `x-encoded-content-encoding: gzip`) and
        // injects its CSP nonce — and that decode path hands the browser an
        // EMPTY 200. Measured 2026-09-10 on NC 34 / AppAPI 34: 0 bytes with
        // gzip accepted, the full shell with identity. Assets are streamed and
        // would survive, but one rule for the whole hop is the one that cannot
        // regress.
        rewriteRequestHeaders(req, SHELL_REQUEST_HEADERS, { 'accept-encoding': 'identity' });
        // http-proxy-middleware rewrites req.url in place. Keep the local
        // path: the fallback hands the request to express.static, which must
        // see `/assets/x.js`, and the one-shot retry must not rewrite twice
        // (`/embed/embed/...`).
        req.__shellUrl = req.url;
        return proxyFor(target)(req, res, next);
    };
}

/** @param {string} target */
function buildEmbedProxyFor(target) {
    const agent = agentFor(target);
    /**
     * @param {import('http').IncomingMessage} req
     * @param {any} res
     * @param {string} why
     */
    const fallBack = (req, res, why) => {
        if (req.__shellUrl !== undefined) req.url = req.__shellUrl;
        log.warn(`[EmbedProxy] ${req.method} ${req.url}: ${why} — falling back to baked /public`);
        if (!res.headersSent && typeof req.__shellNext === 'function') {
            return req.__shellNext();
        }
        if (!res.headersSent) {
            res.status(502).json({ error: 'Bee Flow UI is temporarily unavailable. Please try again.' });
        }
    };
    /** @type {ProxyOptions} */
    const options = {
        target,
        changeOrigin: true,
        agent,
        pathRewrite: (path, req) => rewriteToEmbed(req.__shellUrl ?? path),
        selfHandleResponse: true,
        on: {
            proxyRes: (proxyRes, req, /** @type {any} */ res) => {
                const status = proxyRes.statusCode || 502;
                if (res.headersSent) { proxyRes.resume(); return; }
                if (shouldFallBack(status, req.__shellUrl ?? req.url ?? '')) {
                    proxyRes.resume();
                    fallBack(req, res, `upstream answered ${status}`);
                    return;
                }
                res.statusCode = status;
                for (const [name, value] of Object.entries(proxyRes.headers)) {
                    if (value === undefined || SHELL_RESPONSE_DROP.has(name)) continue;
                    res.setHeader(name, value);
                }
                proxyRes.pipe(res);
            },
            error: (err, req, /** @type {any} */ res) => {
                // Retry once on a fresh socket, then fall through to the
                // baked /public bundle rather than 502 (shell requests are
                // all GET, so every one qualifies for the retry).
                const fallback = () => fallBack(req, res, errMessage(err));
                if (retryOnceOnNetworkError({ err, req, res, agent, middleware: mw, onExhausted: fallback })) {
                    log.warn(`[EmbedProxy] retrying ${req.method} ${req.url} on a fresh socket (${err.code})`);
                    return;
                }
                fallback();
            },
        },
    };
    /** @type {ProxyHandler} */
    const mw = createProxyMiddleware(options); // the error handler above reaches it for the one-shot retry
    return mw;
}

module.exports = {
    buildApiProxy, buildEmbedProxy, isSpaShellPath, rewriteToEmbed,
    API_REQUEST_HEADERS, SHELL_REQUEST_HEADERS,
};
