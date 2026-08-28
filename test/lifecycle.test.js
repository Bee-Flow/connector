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

// AppAPI's Task Processing trigger is a service-level call: it carries the
// shared secret with an EMPTY userId (base64(":"+secret)) and hits POST
// /trigger. It must pass the gate (SERVICE_PATHS) — but only WITH a valid
// secret, unlike the lifecycle paths which skip the secret check entirely.
test('service call POST /trigger passes the gate with a valid shared secret', (_, done) => {
    const header = Buffer.from(':test-secret').toString('base64');
    const req = { method: 'POST', path: '/trigger', url: '/trigger?providerId=x',
                  originalUrl: '/trigger?providerId=x', headers: { 'authorization-app-api': header }, rawBody: '' };
    const res = { status: () => res, json: () => done(new Error('/trigger was rejected despite a valid secret')) };
    appApiAuthMiddleware(req, res, (err) => { assert.ok(!err); done(); });
});

test('POST /trigger with a wrong secret is still rejected', (_, done) => {
    const header = Buffer.from(':wrong-secret').toString('base64');
    const req = { method: 'POST', path: '/trigger', url: '/trigger', originalUrl: '/trigger',
                  headers: { 'authorization-app-api': header }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('/trigger let through with a wrong secret')));
});

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

// The shared secret in AUTHORIZATION-APP-API is what makes the userId half of
// that header trustworthy, so it is verified on every request that claims a
// user. Without this check anything that can reach the connector's port — the
// Docker network it shares with Nextcloud, its deploy daemon and every other
// ExApp — could present base64("admin:anything") and be handed a SaaS JWT for
// the Nextcloud administrator.
test('a wrong shared secret is rejected, whoever it claims to be', (_, done) => {
    const header = Buffer.from('alice:wrong').toString('base64');
    const req = { method: 'POST', path: '/ai/chat/direct/stream', url: '/ai/chat/direct/stream',
                  originalUrl: '/ai/chat/direct/stream',
                  headers: { 'authorization-app-api': header, accept: '*/*' }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: (body) => {
            assert.equal(body.code, 'appapi_secret_mismatch');
            done();
        },
    };
    appApiAuthMiddleware(req, res, () => done(new Error('forged secret was let through')));
});

test('a forged admin identity cannot reach the SPA shell either', (_, done) => {
    const header = Buffer.from('admin:not-the-secret').toString('base64');
    const req = { method: 'GET', path: '/index.html', url: '/index.html', originalUrl: '/index.html',
                  headers: { 'authorization-app-api': header }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('forged secret served the shell')));
});

test('a truncated secret is rejected (length is compared before the bytes)', (_, done) => {
    const header = Buffer.from('alice:test').toString('base64'); // prefix of 'test-secret'
    const req = { method: 'GET', path: '/api/chat', url: '/api/chat', originalUrl: '/api/chat',
                  headers: { 'authorization-app-api': header }, rawBody: '' };
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('prefix of the secret was accepted')));
});
