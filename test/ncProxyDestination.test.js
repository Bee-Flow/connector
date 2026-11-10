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
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.APP_ID = 'bee_flow';

/** @type {Array<{method: string, url: string, destination?: string, body: string, override: unknown, auth: unknown}>} */
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        upstreamSeen.push({
            method: req.method, url: req.url, destination: req.headers.destination,
            body: Buffer.concat(chunks).toString('utf8'),
            override: req.headers['x-http-method-override'],
            auth: req.headers['authorization-app-api'],
        });
        res.statusCode = 201;
        res.end();
    });
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

// ═══ The method tunnel ═══════════════════════════════════════════════════════
//
// AppAPI's PHP proxy has four routes for an ExApp: ExAppGet, ExAppPost,
// ExAppPut and ExAppDelete (app_api appinfo/routes.php, ExAppProxyController).
// PROPFIND, REPORT, MKCOL, MOVE, COPY and PATCH have none, whatever info.xml
// lists for `^/?nc\/.*`. The Bee Flow server therefore sends every verb but GET
// and POST as POST + X-HTTP-Method-Override, signed over the REAL method
// (server/integrations/nextcloudClient.js). This pins the connector's half:
// each of those verbs must reach Nextcloud as itself, with its body intact and
// without the tunnel header.

/**
 * Send `realMethod` the way the server does: as POST with the override header,
 * signed over the real method and the body hash.
 */
function tunnel(realMethod, path, body, { signedMethod = realMethod } = {}) {
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${signedMethod}\n${path}\nalice\n${bodyHash}`).digest('hex');
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: proxyServer.address().port, method: 'POST', path,
            headers: {
                'x-beeflow-sig': `${ts}.${sig}`,
                'x-beeflow-nc-uid': 'alice',
                'x-http-method-override': realMethod,
                'content-length': Buffer.byteLength(body),
            },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end(body);
    });
}

for (const [verb, path, body] of [
    ['PROPFIND', '/nc/remote.php/dav/files/alice/', '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>'],
    ['REPORT', '/nc/remote.php/dav/calendars/alice/personal/', '<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>'],
    ['MKCOL', '/nc/remote.php/dav/files/alice/New%20folder', ''],
    ['PUT', '/nc/remote.php/dav/files/alice/a.json', '{ "kept":   "byte for byte" }'],
    ['DELETE', '/nc/remote.php/dav/files/alice/a.json', ''],
    ['PATCH', '/nc/ocs/v2.php/apps/forms/api/v3/forms/1', '{"keyValuePairs":{"title":"x"}}'],
    ['PROPPATCH', '/nc/remote.php/dav/files/alice/a.json', '<d:propertyupdate xmlns:d="DAV:"/>'],
]) {
    test(`a tunnelled ${verb} reaches Nextcloud as ${verb}`, async () => {
        const status = await tunnel(verb, path, body);
        assert.equal(status, 201);
        const seen = lastUpstream();
        assert.equal(seen.method, verb);
        assert.equal(seen.url, path.slice('/nc'.length));
        assert.equal(seen.body, body);
        assert.equal(seen.override, undefined, 'the tunnel header is ours, not Nextcloud\'s');
        assert.equal(seen.auth, Buffer.from('alice:test-secret').toString('base64'));
    });
}

test('a tunnelled verb signed as another verb is refused before Nextcloud sees it', async () => {
    const before = upstreamSeen.length;
    const status = await tunnel('DELETE', '/nc/remote.php/dav/files/alice/a.json', '', { signedMethod: 'PROPFIND' });
    assert.equal(status, 401);
    assert.equal(upstreamSeen.length, before);
});
