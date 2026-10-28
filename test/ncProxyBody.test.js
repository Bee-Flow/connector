// /nc/* is PUBLIC (info.xml) and reachable by any container on the docker
// network. Its body used to be buffered (up to 100 MB) BEFORE any check, so N
// unsigned uploads held N x 100 MB before each got its 401. Now the signature
// header is checked first, the body is capped per request and in total, and a
// valid signed upload still arrives byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://127.0.0.1:1'; // replaced by the echo upstream below
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.BEEFLOW_NC_PROXY_MAX_BODY_MB = '2';
process.env.BEEFLOW_NC_PROXY_MAX_INFLIGHT_MB = '1';

const express = require('express');
const config = require('../src/config');
const rateLimit = require('../src/rateLimit');

const MB = 1024 * 1024;
const PATH = '/nc/remote.php/dav/files/alice/report.bin';

let upstream;
let received = null;
let server;
let base;
let ncProxy;

function sign(method, p, ncUid, body) {
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const sig = crypto.createHmac('sha256', config.tenantKey).update(`${ts}\n${method}\n${p}\n${ncUid}\n${bodyHash}`).digest('hex');
    return `${ts}.${sig}`;
}

/**
 * Stream `total` bytes in 64 KiB chunks (chunked, as AppAPI sends). Resolves
 * with the response and how many bytes had been written when it arrived.
 */
function upload(headers, total, { pattern = 0x61 } = {}) {
    return new Promise((resolve, reject) => {
        let written = 0;
        let answered = null;
        const req = http.request(`${base}${PATH}`, { method: 'POST', headers }, (res) => {
            answered = written;
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text, writtenAtAnswer: answered }));
        });
        req.on('error', (err) => (answered === null ? reject(err) : undefined));
        const chunk = Buffer.alloc(64 * 1024, pattern);
        const pump = () => {
            while (written < total && answered === null) {
                const n = Math.min(chunk.length, total - written);
                written += n;
                if (!req.write(chunk.subarray(0, n))) { req.once('drain', () => setTimeout(pump, 2)); return; }
            }
            if (answered === null) req.end();
        };
        pump();
    });
}

test.before(async () => {
    upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { received = { method: req.method, url: req.url, body: Buffer.concat(chunks) }; res.end('stored'); });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    config.nextcloudUrl = `http://127.0.0.1:${upstream.address().port}`;
    ncProxy = require('../src/ncProxy');
    const app = express();
    ncProxy.mount(app);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); upstream?.close(); });
test.beforeEach(() => rateLimit.reset());

test('an unsigned upload is refused before its body is read', async () => {
    const res = await upload({ 'Content-Type': 'application/octet-stream' }, 20 * MB);
    assert.equal(res.status, 401);
    assert.ok(res.writtenAtAnswer < 20 * MB, 'the 401 arrives while the client is still uploading');
    assert.equal(ncProxy.inflightBodyBytes(), 0, 'nothing was buffered');
});

test('a stale or malformed signature header is refused before the body too', async () => {
    const stale = `${Math.floor(Date.now() / 1000) - 3600}.${'a'.repeat(64)}`;
    for (const sig of [stale, 'not-a-signature', `${Math.floor(Date.now() / 1000)}.zz`]) {
        const res = await upload({ 'x-beeflow-sig': sig }, 4 * MB);
        assert.equal(res.status, 401, sig);
        assert.ok(res.writtenAtAnswer < 4 * MB);
    }
    assert.equal(ncProxy.inflightBodyBytes(), 0);
});

test('a body over BEEFLOW_NC_PROXY_MAX_BODY_MB is refused with 413', async () => {
    const res = await upload({ 'x-beeflow-sig': `${Math.floor(Date.now() / 1000)}.${'a'.repeat(64)}`, 'Content-Length': String(3 * MB) }, 3 * MB);
    assert.equal(res.status, 413);
    assert.equal(ncProxy.inflightBodyBytes(), 0);
});

test('signature-shaped junk cannot hold more than BEEFLOW_NC_PROXY_MAX_INFLIGHT_MB', async () => {
    const res = await upload({ 'x-beeflow-sig': `${Math.floor(Date.now() / 1000)}.${'a'.repeat(64)}` }, 1.5 * MB);
    assert.equal(res.status, 503);
    assert.equal(ncProxy.inflightBodyBytes(), 0, 'the budget is released');
});

test('a valid signed upload still reaches Nextcloud byte for byte', async () => {
    const total = 768 * 1024;
    const body = Buffer.alloc(total, 0x62);
    const res = await upload({
        'x-beeflow-sig': sign('PUT', PATH, 'alice', body),
        'x-beeflow-nc-uid': 'alice',
        'x-http-method-override': 'PUT',
        'Content-Type': 'application/octet-stream',
    }, total, { pattern: 0x62 });
    assert.equal(res.status, 200, res.text);
    assert.equal(received.method, 'PUT');
    assert.equal(received.url, '/remote.php/dav/files/alice/report.bin');
    assert.ok(received.body.equals(body));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ncProxy.inflightBodyBytes(), 0);
});
