// Regression test: AppAPI 5.x calls /heartbeat /init /enabled WITHOUT
// signature headers. Confirmed empirically against AppAPI 5.0.2 in May 2026.
// If this test fails, lifecycle endpoints will 401 and ExApp install gets
// stuck at "0% initialiseren" in the Nextcloud UI.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { appApiAuthMiddleware } = require('../src/auth');

function unsignedReq(path) {
    return { method: 'GET', path, url: path, originalUrl: path, headers: {}, rawBody: '' };
}

for (const path of ['/heartbeat', '/init', '/enabled']) {
    test(`unsigned ${path} bypasses signature check`, (_, done) => {
        const req = unsignedReq(path);
        const res = { status: () => res, json: () => done(new Error(`${path} was rejected`)) };
        appApiAuthMiddleware(req, res, (err) => {
            assert.ok(!err, `${path} unexpectedly errored: ${err}`);
            done();
        });
    });
}

test('user-facing /api/* still requires signature', (_, done) => {
    const req = unsignedReq('/api/chat');
    const res = {
        status: (code) => { assert.equal(code, 401); return res; },
        json: () => done(),
    };
    appApiAuthMiddleware(req, res, () => done(new Error('/api/chat was let through unsigned')));
});
