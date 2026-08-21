// /heartbeat is declared PUBLIC in info.xml — AppAPI has to be able to poll it
// before any user session exists, which also means anyone on the internet can
// GET it through <nextcloud>/index.php/apps/app_api/proxy/bee_flow/heartbeat.
//
// So the failure DIAGNOSIS it can carry — the Bee Flow server URL, the raw
// upstream error, remediation text describing the operator's egress rules and
// container name — is exactly the "sensitive data exposure" case in
// developer_manual/prologue/security.html. The coarse state stays public (it
// answers "is this install stuck?"); the diagnosis needs the shared secret.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto'; // no tenant key ⇒ a failure is reportable

const { registerLifecycle } = require('../src/heartbeat');
const bootstrap = require('../src/bootstrap');

// A stuck bootstrap whose error names internal infrastructure.
const FAILURE = {
    status: 'failed',
    category: 'saas_unreachable',
    error: 'fetch failed: connect ECONNREFUSED http://bee-flow-server.internal:3001',
    lastAttemptAt: '2026-08-14T10:00:00.000Z',
    nextRetryAt: '2026-08-14T10:01:00.000Z',
};

function appStub() {
    const routes = {};
    return {
        get: (path, handler) => { routes[`GET ${path}`] = handler; },
        post: (path, handler) => { routes[`POST ${path}`] = handler; },
        put: (path, handler) => { routes[`PUT ${path}`] = handler; },
        routes,
    };
}

function callHeartbeat(headers) {
    const app = appStub();
    registerLifecycle(app);
    let body = null;
    app.routes['GET /heartbeat']({ headers }, { json: (b) => { body = b; return b; } });
    return body;
}

test.before(() => { bootstrap.getLastErrorState = () => FAILURE; });

test('an anonymous caller learns that bootstrap failed, and nothing about the network', () => {
    const body = callHeartbeat({});
    assert.equal(body.status, 'ok', "AppAPI's liveness contract must hold either way");
    assert.equal(body.bootstrap, 'failed', 'the coarse state is not a secret');
    assert.equal(body.error, undefined, 'the raw upstream error must not be public');
    assert.equal(body.category, undefined);
    assert.ok(!JSON.stringify(body).includes('bee-flow-server.internal'),
        `no internal hostname may appear: ${JSON.stringify(body)}`);
});

test('a caller holding the AppAPI shared secret gets the full diagnosis', () => {
    const header = Buffer.from(':test-secret').toString('base64');
    const body = callHeartbeat({ 'authorization-app-api': header });
    assert.equal(body.bootstrap, 'failed');
    assert.equal(body.category, 'saas_unreachable');
    assert.ok(body.error.includes('bee-flow-server.internal'));
    assert.ok(body.remediation, 'the operator gets actionable remediation');
});

test('a wrong secret is treated as anonymous, not as trusted', () => {
    const header = Buffer.from(':guessed').toString('base64');
    const body = callHeartbeat({ 'authorization-app-api': header });
    assert.equal(body.error, undefined);
});
