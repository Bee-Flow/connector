// WebDAV MOVE / COPY / restore name their target in a `Destination` header. The
// request line is rewritten by AppAPI/HaRP and by the proxy (`/nc` stripped), the
// header is not, so Sabre saw a URI outside its base and answered 403. The proxy
// now rewrites it to the Nextcloud URL, but only inside /remote.php/dav/ and only
// for a known host.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

process.env.APP_SECRET = 'test-secret';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_ID = 'bee_flow';

/** @type {Array<{method: string, url: string, destination?: string}>} */
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
    upstreamSeen.push({ method: req.method, url: req.url, destination: req.headers.destination });
    res.statusCode = 201;
    res.end();
});

let proxyServer;
let ncProxy;
let config;
let base;

test.before(async () => {
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    process.env.NEXTCLOUD_URL = `http://127.0.0.1:${upstream.address().port}`;
    config = require('../src/config');
    ncProxy = require('../src/ncProxy');
    const app = express();
    ncProxy.mount(app);
    proxyServer = http.createServer(app);
    await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
    base = `127.0.0.1:${proxyServer.address().port}`;
});

test.after(() => {
    proxyServer?.close();
    upstream.close();
});

function send(method, path, destination) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${method}\n${path}\nalice`).digest('hex');
    return new Promise((resolve, reject) => {
        const headers = { 'x-beeflow-sig': `${ts}.${sig}`, 'x-beeflow-nc-uid': 'alice' };
        if (destination !== undefined) headers.Destination = destination;
        const req = http.request({
            host: '127.0.0.1', port: proxyServer.address().port, method, path, headers,
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
    });
}

const CALLBACK = () => `http://${base}/index.php/apps/app_api/proxy/bee_flow`;
const lastUpstream = () => upstreamSeen[upstreamSeen.length - 1];

test('MOVE: Destination under the callback /nc becomes the Nextcloud URL', async () => {
    const status = await send('MOVE', '/nc/remote.php/dav/files/alice/T/a.txt',
        `${CALLBACK()}/nc/remote.php/dav/files/alice/T/c.txt`);
    assert.equal(status, 201);
    assert.equal(lastUpstream().method, 'MOVE');
    assert.equal(lastUpstream().url, '/remote.php/dav/files/alice/T/a.txt');
    assert.equal(lastUpstream().destination, `${config.nextcloudUrl}/remote.php/dav/files/alice/T/c.txt`);
});

test('COPY: a plain /nc Destination on the request host is rewritten', async () => {
    const status = await send('COPY', '/nc/remote.php/dav/files/alice/T/a.txt',
        `http://${base}/nc/remote.php/dav/files/alice/T/b%20copy.txt`);
    assert.equal(status, 201);
    assert.equal(lastUpstream().destination, `${config.nextcloudUrl}/remote.php/dav/files/alice/T/b%20copy.txt`);
});

test('restore from trash: Destination in the user restore folder is rewritten', async () => {
    const status = await send('MOVE', '/nc/remote.php/dav/trashbin/alice/trash/a.txt.d1700000000',
        `${CALLBACK()}/nc/remote.php/dav/trashbin/alice/restore/a.txt.d1700000000`);
    assert.equal(status, 201);
    assert.equal(lastUpstream().destination,
        `${config.nextcloudUrl}/remote.php/dav/trashbin/alice/restore/a.txt.d1700000000`);
});

test('a request without Destination passes through untouched', async () => {
    const status = await send('PROPFIND', '/nc/remote.php/dav/files/alice/');
    assert.equal(status, 201);
    assert.equal(lastUpstream().destination, undefined);
});

for (const [name, destination] of [
    ['another host', 'http://evil.example/nc/remote.php/dav/files/alice/x'],
    ['a host that merely starts with the request host', `http://${base}.evil.example/nc/remote.php/dav/files/alice/x`],
    ['userinfo smuggling', `http://${base}@evil.example/nc/remote.php/dav/files/alice/x`],
    ['an ocs path outside the DAV tree', `${CALLBACK()}/nc/ocs/v2.php/cloud/users`],
    ['a path outside /nc', `http://${base}/remote.php/dav/files/alice/x`],
    ['dot-dot escape', `${CALLBACK()}/nc/remote.php/dav/../../index.php/apps/x`],
    ['encoded dot-dot escape', `${CALLBACK()}/nc/remote.php/dav/%2e%2e/%2e%2e/ocs/v2.php/x`],
    ['double-encoded dot-dot escape', `${CALLBACK()}/nc/remote.php/dav/%252e%252e/ocs/x`],
    ['a backslash', `${CALLBACK()}/nc/remote.php/dav/files/alice\\..\\..\\x`],
    ['a relative path', '/nc/remote.php/dav/files/alice/x'],
    ['another app route', `http://${base}/index.php/apps/app_api/proxy/other_app/nc/remote.php/dav/files/alice/x`],
]) {
    test(`hostile Destination is refused with 403: ${name}`, async () => {
        const before = upstreamSeen.length;
        const status = await send('MOVE', '/nc/remote.php/dav/files/alice/T/a.txt', destination);
        assert.equal(status, 403);
        assert.equal(upstreamSeen.length, before, 'nothing reached Nextcloud');
    });
}
