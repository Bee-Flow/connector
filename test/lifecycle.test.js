// AppAPI 5.x calls /heartbeat /init /enabled WITHOUT auth headers.
// Asset paths /img/* /js/* must also be reachable for NC's chrome injection.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { appApiAuthMiddleware } = require('../src/auth');

function unsignedReq(path) {
    return { method: 'GET', path, url: path, originalUrl: path, headers: {}, rawBody: '' };
}

for (const path of ['/heartbeat', '/init', '/enabled', '/img/app.svg', '/js/embed', '/js/embed.js']) {
    test(`unsigned ${path} bypasses auth`, (_, done) => {
        const req = unsignedReq(path);
        const res = { status: () => res, json: () => done(new Error(`${path} was rejected`)) };
        appApiAuthMiddleware(req, res, (err) => {
            assert.ok(!err);
            done();
        });
    });
}

test('user-facing /api/* without header → 401', (_, done) => {
    const req = unsignedReq('/api/chat');
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('let through unsigned')));
});

test('anonymous (empty user) → 401 on user-facing path', (_, done) => {
    const header = Buffer.from(':test-secret').toString('base64');
    const req = { method: 'GET', path: '/api/chat', url: '/api/chat', originalUrl: '/api/chat',
                  headers: { 'authorization-app-api': header }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('anon let through on API path')));
});

test('anonymous (empty user) → next() on SPA shell paths', (_, done) => {
    const header = Buffer.from(':test-secret').toString('base64');
    let pending = 3;
    const check = (err) => {
        if (err) return done(err);
        if (--pending === 0) done();
    };
    for (const path of ['/', '/assets/index-abc.js', '/index.html']) {
        const req = { method: 'GET', path, url: path, originalUrl: path,
                      headers: { 'authorization-app-api': header }, rawBody: '' };
        const res = {
            status: () => res,
            json: () => check(new Error(`${path} was rejected for anon SPA shell`)),
        };
        appApiAuthMiddleware(req, res, () => check(null));
    }
});

// The connector deliberately does NOT re-verify the AppAPI shared secret — see
// the "Trust boundary" comment in src/auth.js. NC signs every proxied request
// and is the only thing that can reach this port, so the header is treated as a
// user-identity envelope; the load-bearing secret is the tenant key, verified on
// every SaaS-bound JWT and every SaaS callback. This test used to assert a 401
// for a bad secret, which the code stopped doing when that boundary was drawn —
// and it never caught the drift because it was throwing (`req.accepts is not a
// function`) rather than asserting. It now pins the behaviour that IS the
// contract: identity is taken from the header, and an unreachable Nextcloud
// fails the API call closed with a 502 rather than forwarding it unauthenticated.
test('secret is not re-verified; an unreachable NC fails API calls closed (502)', (_, done) => {
    const header = Buffer.from('alice:wrong').toString('base64');
    const req = { method: 'POST', path: '/ai/chat/direct/stream', url: '/ai/chat/direct/stream',
                  originalUrl: '/ai/chat/direct/stream',
                  headers: { 'authorization-app-api': header, accept: '*/*' }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 502); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('chat POST forwarded without a JWT')));
});
