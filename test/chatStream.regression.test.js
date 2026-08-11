/**
 * Transport regressions on the browser → Nextcloud → connector → SaaS chat path.
 *
 * Each case here was a real, reproduced failure whose only user-visible symptom
 * was a blank assistant reply with no error — because the SPA's SSE reader
 * cannot distinguish "200 with an unusable body" from "the answer was empty".
 * The connector is the only place these can be caught, so they are pinned here.
 *
 * The tests drive the REAL buildApiProxy() against a throwaway upstream, with
 * the same express.json() the entrypoint installs, so nothing about the
 * request/response rewriting is mocked.
 */
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');

const config = require('../src/config');

const SSE_BODY =
    'event: conversation_created\ndata: {"conversationId":"c1"}\n\n' +
    'event: content\ndata: {"text":"Hallo"}\n\n' +
    'event: done\ndata: {}\n\n';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
const close = (server) => new Promise((resolve) => server.close(resolve));

/** Upstream stand-in for the Bee Flow server. `handler(req,res)` decides the reply. */
async function startUpstream(handler) {
    const seen = { acceptEncoding: null, contentLength: null, transferEncoding: null, method: null, rawBody: '' };
    const srv = http.createServer((req, res) => {
        seen.acceptEncoding = req.headers['accept-encoding'] ?? null;
        seen.contentLength = req.headers['content-length'] ?? null;
        seen.transferEncoding = req.headers['transfer-encoding'] ?? null;
        seen.method = req.method;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            seen.rawBody = Buffer.concat(chunks).toString('utf8');
            handler(req, res, seen);
        });
    });
    await listen(srv);
    return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

/** Connector stand-in: the entrypoint's body parser + the real API proxy. */
async function startConnector() {
    delete require.cache[require.resolve('../src/proxy')];
    const { buildApiProxy } = require('../src/proxy');
    const app = express();
    app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use((req, _res, next) => { req.beeflow = { jwt: 'jwt.test', user: { uid: 'alice' } }; next(); });
    app.use(buildApiProxy());
    const srv = http.createServer(app);
    await listen(srv);
    return srv;
}

/**
 * Issue a request the way the browser does. `chunked: true` reproduces what
 * Nextcloud's AppAPI proxy actually sends: ExAppProxyController drops
 * content-length from the forwarded headers and streams php://input through
 * Guzzle, which then frames the body chunked.
 */
function request(port, { method = 'POST', path = '/ai/chat/direct/stream', headers = {}, body = null, chunked = false, delayBodyMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const h = { ...headers };
        if (body != null && !chunked) h['Content-Length'] = Buffer.byteLength(body);
        const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        const send = () => { if (body != null) req.write(body); req.end(); };
        // `delayBodyMs` sends the headers first and the body a beat later, so the
        // proxy's request hook runs while req.readableLength is still 0. That is
        // the state in which fixRequestBody() stops bailing out and actually
        // rewrites the body — the difference between a latent bug and a live one.
        if (delayBodyMs > 0) setTimeout(send, delayBodyMs); else send();
    });
}

/** Decode per Content-Encoding, as a browser does before the SSE reader sees it. */
function decodeLikeABrowser(headers, body) {
    const enc = String(headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip') return zlib.gunzipSync(body);
    if (enc === 'deflate') return zlib.inflateSync(body);
    if (enc === 'br') return zlib.brotliDecompressSync(body);
    return body;
}

/** The SPA's reader, verbatim in behaviour: only `event:`/`data:` lines count. */
function parseLikeTheSpa(buf) {
    const events = [];
    let current = '';
    for (const raw of buf.toString('utf8').split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('event:')) current = line.slice(6).trim();
        else if (line.startsWith('data:')) {
            try { events.push([current, JSON.parse(line.slice(5).replace(/^ /, ''))]); } catch (_) { /* dropped, as the SPA does */ }
        }
    }
    return events;
}

const assistantText = (events) => events.filter(([e]) => e === 'content').map(([, d]) => d.text).join('');

async function withStack(handler, fn) {
    const upstream = await startUpstream(handler);
    const previousApiBase = config.apiBaseUrl;
    config.apiBaseUrl = upstream.url;
    const connector = await startConnector();
    try {
        await fn({ port: connector.address().port, seen: upstream.seen });
    } finally {
        config.apiBaseUrl = previousApiBase;
        await close(connector);
        await close(upstream.srv);
    }
}

const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

// ── Compression ───────────────────────────────────────────────────────────
//
// The connector cannot decompress a body it only pipes through, so it used to
// DELETE `Content-Encoding` on SSE responses — handing the browser gzip bytes
// labelled text/event-stream. Zero `data:` lines matched, and the chat rendered
// a blank reply with no error at all.

test('SSE: the connector asks the SaaS not to compress', async () => {
    await withStack((_req, res) => { res.writeHead(200, sseHeaders); res.end(SSE_BODY); }, async ({ port, seen }) => {
        await request(port, {
            headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' },
            body: JSON.stringify({ message: 'hi' }),
        });
        assert.equal(seen.acceptEncoding, 'identity',
            'the browser\'s Accept-Encoding must not be forwarded — a compressing hop breaks SSE');
    });
});

test('SSE: a compressed stream still decodes (Content-Encoding is preserved, not deleted)', async () => {
    await withStack((_req, res) => {
        // A hop that compresses regardless of Accept-Encoding — belt and braces.
        res.writeHead(200, { ...sseHeaders, 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from(SSE_BODY)));
    }, async ({ port }) => {
        const res = await request(port, {
            headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
            body: JSON.stringify({ message: 'hi' }),
        });
        assert.equal(res.headers['content-encoding'], 'gzip',
            'deleting Content-Encoding while forwarding compressed bytes corrupts the stream');
        const events = parseLikeTheSpa(decodeLikeABrowser(res.headers, res.body));
        assert.equal(assistantText(events), 'Hallo');
    });
});

// ── Request framing ───────────────────────────────────────────────────────
//
// fixRequestBody() re-serialises the parsed body and sets Content-Length, but
// http-proxy had already copied the inbound `Transfer-Encoding: chunked` onto
// the outbound request. A message framed BOTH ways must be rejected (RFC 9112
// §6.1) and Node does exactly that: 400, route handler never invoked.

test('a chunked POST body (what AppAPI sends) reaches the SaaS intact and singly framed', async () => {
    await withStack((_req, res, seen) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: JSON.parse(seen.rawBody || '{}').message }));
    }, async ({ port, seen }) => {
        const res = await request(port, {
            chunked: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'hi', modelTier: 'fast' }),
        });
        assert.equal(res.status, 200, 'a doubly-framed request is rejected upstream with 400');
        assert.equal(seen.transferEncoding, null, 'must not send Transfer-Encoding alongside Content-Length');
        assert.ok(seen.contentLength, 'the re-serialised body needs a Content-Length');
        assert.equal(JSON.parse(seen.rawBody).message, 'hi');
    });
});

test('a Content-Length POST body still reaches the SaaS intact', async () => {
    await withStack((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); },
        async ({ port, seen }) => {
            await request(port, {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'hi' }),
            });
            assert.equal(JSON.parse(seen.rawBody).message, 'hi');
        });
});

// CHARACTERIZATION (not a fixed regression): express.json() assigns
// `req.body = {}` before it checks the content-type, so a multipart upload
// reaches the proxy with a truthy-but-empty body — which the old `if (req.body)`
// guard happily handed to fixRequestBody, whose multipart branch re-encodes `{}`
// as an empty document. Measured against the pinned http-proxy-middleware the
// upload nonetheless survives (verified with the body deliberately delayed so
// req.readableLength is 0, the state in which fixRequestBody stops bailing out),
// so this was NOT a live bug here. The content-type guard in proxy.js makes that
// independent of a transitive dependency's internals, and this test is the
// tripwire if a future version changes them.
test('a multipart upload body is NOT replaced by an empty document (body arrives late)', async () => {
    const multipart = '--abc\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello file\r\n--abc--\r\n';
    await withStack((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); },
        async ({ port, seen }) => {
            await request(port, {
                headers: { 'Content-Type': 'multipart/form-data; boundary=abc' },
                body: multipart,
                delayBodyMs: 25,
            });
            assert.ok(seen.rawBody.includes('hello file'),
                `the upload body must survive the proxy hop, got: ${JSON.stringify(seen.rawBody)}`);
        });
});

// ── Method tunnelling ─────────────────────────────────────────────────────
//
// AppAPI registers no PATCH proxy route (appinfo/routes.php has Get/Post/Put/
// Delete only, and requestToExAppInternal's match() has no PATCH arm), so the
// SPA sends PATCH as POST + override when embedded.
test('X-HTTP-Method-Override: PATCH is restored before the SaaS sees it', async () => {
    await withStack((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); },
        async ({ port, seen }) => {
            await request(port, {
                path: '/ai/direct/conversations/c1',
                headers: { 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'PATCH' },
                body: JSON.stringify({ title: 'Renamed' }),
            });
            assert.equal(seen.method, 'PATCH');
            assert.equal(JSON.parse(seen.rawBody).title, 'Renamed');
        });
});

test('the override header does not let an arbitrary method through', async () => {
    await withStack((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); },
        async ({ port, seen }) => {
            await request(port, {
                headers: { 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'DELETE' },
                body: JSON.stringify({}),
            });
            assert.equal(seen.method, 'POST', 'only PATCH is tunnelled; anything else stays a POST');
        });
});

// ── Response framing ──────────────────────────────────────────────────────

test('SSE keeps the close-framing workaround for the PHP proxy path', async () => {
    delete process.env.HP_SHARED_KEY; // non-HaRP: NC's PHP proxy is in the path
    await withStack((_req, res) => { res.writeHead(200, sseHeaders); res.end(SSE_BODY); }, async ({ port }) => {
        const res = await request(port, {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'hi' }),
        });
        assert.equal(res.headers['transfer-encoding'], undefined);
        assert.equal(res.headers['content-length'], undefined);
        assert.equal(res.headers['connection'], 'close');
        assert.equal(res.headers['x-accel-buffering'], 'no');
        assert.equal(assistantText(parseLikeTheSpa(res.body)), 'Hallo');
    });
});

test('a non-SSE JSON response is passed through untouched', async () => {
    await withStack((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversations: [1, 2] }));
    }, async ({ port }) => {
        const res = await request(port, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.deepEqual(JSON.parse(res.body.toString('utf8')).conversations, [1, 2]);
    });
});
