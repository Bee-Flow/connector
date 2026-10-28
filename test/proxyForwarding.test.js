// What the two proxies (SPA API → Bee Flow server, SPA shell → frontend host)
// send upstream, and where. Every test drives the real buildApiProxy() /
// buildEmbedProxy() against a throwaway upstream.
//
//   - Request headers are an allow-list: AppAPI's AUTHORIZATION-APP-API
//     (base64 "<uid>:<APP_SECRET>") and every other AppAPI / Nextcloud header
//     must never reach either upstream, including a header nobody has invented
//     yet and a request with `Expect: 100-continue` (http-proxy skips its
//     proxyReq hook for those).
//   - The API target follows config.apiBaseUrl at request time.
//   - Long-lived streams cannot starve other requests, and a request that
//     waits for a socket still gets an answer.
//   - The shell falls back to the baked bundle on an upstream 5xx (and a
//     missing index.html), not only on a network error.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

process.env.APP_SECRET = 'S3CRET-app-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const express = require('express');

const SECRET_B64 = Buffer.from('alice:S3CRET-app-secret').toString('base64');
const APPAPI_HEADERS = {
    'AUTHORIZATION-APP-API': SECRET_B64,
    'EX-APP-ID': 'bee_flow',
    'EX-APP-VERSION': '1.6.4',
    'AA-VERSION': '35.0.0',
    'AA-REQUEST-ID': 'req-1',
    'Authorization': `Basic ${Buffer.from('alice:nc-password').toString('base64')}`,
    'Cookie': 'nc_session_id=abc; oc_sessionPassphrase=xyz',
    'Origin': 'https://cloud.example.com',
    'Referer': 'https://cloud.example.com/apps/app_api/embedded/bee_flow/main',
    'X-Forwarded-For': '203.0.113.7',
    'X-Forwarded-Host': 'cloud.example.com',
    'X-Beeflow-NC-Uid': 'admin', // a spoof: the connector decides the uid
    'X-Nextcloud-Future-Credential': 'not-yet-invented',
    'Requesttoken': 'csrf-token',
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

function freshProxyModule(env = {}) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/proxy')];
    return { config: require('../src/config'), proxy: require('../src/proxy') };
}

/** An upstream that answers every request with the headers it received. */
async function echoUpstream(name = 'echo') {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ url: req.url, headers: req.headers, body });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ name, url: req.url, headers: req.headers, body }));
        });
    });
    await listen(srv);
    return { srv, seen };
}

async function apiConnector(proxyModule) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.beeflow = { jwt: 'jwt.test', user: { uid: 'alice', email: null, displayName: 'Alice', isNcAdmin: false } }; next(); });
    const mw = proxyModule.buildApiProxy();
    app.use((req, res, next) => mw(req, res, next));
    return listen(http.createServer(app));
}

async function shellConnector(proxyModule, fallbackBody = 'BAKED_SHELL') {
    const mw = proxyModule.buildEmbedProxy();
    const fellBackFor = [];
    const app = express();
    app.use((req, res, next) => {
        req.__shellNext = () => { fellBackFor.push(req.url); res.status(200).send(fallbackBody); };
        mw(req, res, next);
    });
    const srv = await listen(http.createServer(app));
    return { srv, fellBackFor };
}

function request(base, path, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${path}`, { method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function assertNoAppApiCredential(headers) {
    const dump = JSON.stringify(headers);
    assert.ok(!dump.includes(SECRET_B64), 'the base64 AppAPI credential reached the upstream');
    assert.ok(!dump.includes('S3CRET-app-secret'), 'the APP_SECRET reached the upstream');
    for (const name of ['authorization-app-api', 'ex-app-id', 'ex-app-version', 'aa-version', 'aa-request-id',
        'cookie', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'x-nextcloud-future-credential', 'requesttoken']) {
        assert.equal(headers[name], undefined, `${name} must not be forwarded`);
    }
}

test('API proxy: no AppAPI or Nextcloud credential reaches the Bee Flow server, the connector headers do', async () => {
    const up = await echoUpstream();
    const { proxy } = freshProxyModule({ BEEFLOW_API_BASE_URL: urlOf(up.srv) });
    const conn = await apiConnector(proxy);
    try {
        const res = await request(urlOf(conn), '/agents?x=1', {
            headers: { ...APPAPI_HEADERS, Accept: 'application/json', 'If-None-Match': '"v1"', 'Accept-Encoding': 'gzip' },
        });
        assert.equal(res.status, 200);
        const { headers, url } = JSON.parse(res.text);
        assertNoAppApiCredential(headers);
        assert.equal(url, '/agents?x=1');
        assert.equal(headers.authorization, 'Bearer jwt.test');
        assert.equal(headers['x-beeflow-nc-uid'], 'alice');
        assert.equal(headers['x-beeflow-source'], 'nextcloud-connector');
        assert.equal(headers['x-beeflow-nc-base-url'], 'http://nc.test');
        assert.equal(headers['accept-encoding'], 'identity');
        // Allow-listed browser headers still pass.
        assert.equal(headers.accept, 'application/json');
        assert.equal(headers['if-none-match'], '"v1"');
    } finally {
        await close(conn); await close(up.srv);
    }
});

test('API proxy: a body sent with Expect: 100-continue is filtered too, and arrives intact', async () => {
    const up = await echoUpstream();
    const { proxy } = freshProxyModule({ BEEFLOW_API_BASE_URL: urlOf(up.srv) });
    const conn = await apiConnector(proxy);
    try {
        const payload = 'x'.repeat(4096);
        const res = await new Promise((resolve, reject) => {
            const req = http.request(`${urlOf(conn)}/documents/upload`, {
                method: 'POST',
                headers: { ...APPAPI_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length), Expect: '100-continue' },
            }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t })); });
            req.on('continue', () => req.end(payload));
            req.on('error', reject);
        });
        assert.equal(res.status, 200);
        const { headers, body } = JSON.parse(res.text);
        assertNoAppApiCredential(headers);
        assert.equal(headers.expect, undefined);
        assert.equal(headers.authorization, 'Bearer jwt.test');
        assert.equal(body, payload);
    } finally {
        await close(conn); await close(up.srv);
    }
});

test('shell proxy: no AppAPI or Nextcloud credential reaches the frontend host', async () => {
    const up = await echoUpstream();
    const { proxy } = freshProxyModule({ BEEFLOW_EMBED_BASE_URL: urlOf(up.srv) });
    const { srv } = await shellConnector(proxy);
    try {
        for (const path of ['/', '/index.html', '/assets/index-abc.js']) {
            const res = await request(urlOf(srv), path, { headers: { ...APPAPI_HEADERS, 'If-None-Match': '"e1"' } });
            assert.equal(res.status, 200, path);
            const { headers, url } = JSON.parse(res.text);
            assertNoAppApiCredential(headers);
            assert.equal(headers.authorization, undefined, 'the shell host gets no Authorization at all');
            assert.equal(headers['x-beeflow-nc-uid'], undefined, 'the shell host learns nothing about the user');
            assert.equal(headers['if-none-match'], '"e1"');
            assert.equal(url, `/embed${path}`);
        }
    } finally {
        await close(srv); await close(up.srv);
    }
});

test('API proxy follows a runtime change of config.apiBaseUrl', async () => {
    const a = await echoUpstream('A');
    const b = await echoUpstream('B');
    const { proxy, config } = freshProxyModule({ BEEFLOW_API_BASE_URL: urlOf(a.srv) });
    const conn = await apiConnector(proxy);
    try {
        assert.equal(JSON.parse((await request(urlOf(conn), '/agents')).text).name, 'A');
        config.apiBaseUrl = urlOf(b.srv);
        assert.equal(JSON.parse((await request(urlOf(conn), '/agents')).text).name, 'B');
        config.apiBaseUrl = urlOf(a.srv);
        assert.equal(JSON.parse((await request(urlOf(conn), '/agents')).text).name, 'A');
    } finally {
        await close(conn); await close(a.srv); await close(b.srv);
    }
});

test('API proxy speaks TLS to an https target after a switch from http', async () => {
    const a = await echoUpstream('A');
    // A raw socket server: records whether the first byte is a TLS handshake
    // record (0x16), then hangs up. Proves the https agent was picked.
    let firstByte = null;
    const tlsProbe = net.createServer((s) => s.once('data', (d) => { firstByte = d[0]; s.destroy(); }));
    await listen(tlsProbe);
    const { proxy, config } = freshProxyModule({ BEEFLOW_API_BASE_URL: urlOf(a.srv) });
    const conn = await apiConnector(proxy);
    try {
        assert.equal(JSON.parse((await request(urlOf(conn), '/agents')).text).name, 'A');
        config.apiBaseUrl = `https://127.0.0.1:${tlsProbe.address().port}`;
        const res = await request(urlOf(conn), '/agents', { method: 'POST' });
        assert.equal(res.status, 502);
        assert.equal(firstByte, 0x16, 'the connector must open a TLS session to an https target');
    } finally {
        await close(conn); await close(a.srv); await close(tlsProbe);
    }
});

test('64 open streams do not block the 65th request', { timeout: 15000 }, async () => {
    const up = http.createServer((req, res) => {
        if (req.url.startsWith('/stream')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: hi\n\n');
            return; // never ends
        }
        res.end('ok');
    });
    await listen(up);
    const { proxy } = freshProxyModule({ BEEFLOW_API_BASE_URL: urlOf(up), BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS: '3000' });
    const conn = await apiConnector(proxy);
    const client = new http.Agent({ keepAlive: false, maxSockets: 1000 });
    const streams = [];
    try {
        await Promise.all(Array.from({ length: 64 }, (_, i) => new Promise((resolve) => {
            const r = http.get(`${urlOf(conn)}/stream/${i}`, { agent: client }, (res) => { res.on('data', () => {}); resolve(); });
            streams.push(r);
        })));
        const t0 = Date.now();
        const res = await new Promise((resolve, reject) => {
            http.get(`${urlOf(conn)}/api/health`, { agent: client }, (r) => {
                let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t }));
            }).on('error', reject);
        });
        assert.equal(res.status, 200);
        assert.equal(res.text, 'ok');
        assert.ok(Date.now() - t0 < 2000, 'the request must not wait for a stream to end');
    } finally {
        for (const r of streams) r.destroy();
        client.destroy();
        await close(conn); await close(up);
        delete process.env.BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS;
    }
});

test('a request queued behind a socket cap still gets an answer within the headers timeout', { timeout: 15000 }, async () => {
    const up = http.createServer((req, res) => {
        if (req.url.startsWith('/stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hi\n\n'); return; }
        res.end('ok');
    });
    await listen(up);
    const { proxy } = freshProxyModule({
        BEEFLOW_API_BASE_URL: urlOf(up), BEEFLOW_UPSTREAM_MAX_SOCKETS: '1', BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS: '300',
    });
    const conn = await apiConnector(proxy);
    const client = new http.Agent({ keepAlive: false });
    let stream;
    try {
        await new Promise((resolve) => { stream = http.get(`${urlOf(conn)}/stream/1`, { agent: client }, (r) => { r.on('data', () => {}); resolve(); }); });
        const t0 = Date.now();
        const res = await request(urlOf(conn), '/api/health');
        assert.equal(res.status, 504);
        assert.ok(Date.now() - t0 < 2000);
    } finally {
        stream?.destroy();
        client.destroy();
        await close(conn); await close(up);
        delete process.env.BEEFLOW_UPSTREAM_MAX_SOCKETS;
        delete process.env.BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS;
    }
});

test('shell proxy falls back to the baked shell on an upstream 5xx and on a missing index.html', async () => {
    let status = 503;
    const up = http.createServer((req, res) => {
        res.statusCode = status;
        res.setHeader('set-cookie', 'cdn=1; Domain=beeflow.nl');
        res.setHeader('etag', '"u1"');
        res.end(`upstream ${status} ${req.url}`);
    });
    await listen(up);
    const { proxy } = freshProxyModule({ BEEFLOW_EMBED_BASE_URL: urlOf(up) });
    const { srv, fellBackFor } = await shellConnector(proxy);
    try {
        let res = await request(urlOf(srv), '/index.html');
        assert.equal(res.text, 'BAKED_SHELL', 'a 503 from the frontend host must not reach the Nextcloud frame');
        res = await request(urlOf(srv), '/assets/app-1.js');
        assert.equal(res.text, 'BAKED_SHELL');
        // The fallback sees the connector-local path, not the /embed one.
        assert.deepEqual(fellBackFor, ['/index.html', '/assets/app-1.js']);

        status = 404;
        res = await request(urlOf(srv), '/');
        assert.equal(res.text, 'BAKED_SHELL', 'a missing index.html falls back');
        res = await request(urlOf(srv), '/assets/gone.js');
        assert.equal(res.status, 404, 'a missing asset stays a 404');

        status = 200;
        res = await request(urlOf(srv), '/assets/app-1.js');
        assert.equal(res.status, 200);
        assert.equal(res.text, 'upstream 200 /embed/assets/app-1.js');
        assert.equal(res.headers.etag, '"u1"');
        assert.equal(res.headers['set-cookie'], undefined, 'a frontend-host cookie never lands on the Nextcloud origin');
    } finally {
        await close(srv); await close(up);
    }
});

test('a shell path with a .. segment never reaches the frontend host', async () => {
    const up = await echoUpstream();
    const { proxy } = freshProxyModule({ BEEFLOW_EMBED_BASE_URL: urlOf(up.srv) });
    const mw = proxy.buildEmbedProxy();
    const app = express();
    app.use((req, res) => mw(req, res, () => res.status(404).send('LOCAL')));
    const srv = await listen(http.createServer(app));
    try {
        // A raw request line: a URL object would resolve the dots client-side.
        const raw = (p) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, (r) => {
                let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve(t));
            }).on('error', reject);
        });
        for (const p of ['/assets/../../user-page.html', '/assets/%2e%2e/%2e%2e/user-page.html', '/assets/%252e%252e/x', '/assets/..%2f..%2fx', '/assets/./x.js']) {
            assert.equal(await raw(p), 'LOCAL', p);
        }
        assert.equal(up.seen.length, 0, 'the frontend host was never asked');
        // An ordinary asset still is.
        await request(urlOf(srv), '/assets/app-1.js');
        assert.equal(up.seen.length, 1);
    } finally {
        await close(srv); await close(up.srv);
    }
});
