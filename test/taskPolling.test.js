// Task Processing: the trigger route verb, and that the idle poller is armed
// once bootstrap sets the tenant key.
//
// The bug this guards: startPolling() early-returns while config.tenantKey is
// null, and its only boot-time caller runs BEFORE bootstrap — so on an
// auto-bootstrap install the poll backstop never started and queued Assistant
// tasks were never drained. Bootstrap now arms it when the key is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Auto tenant-key mode (default one-click install): unset so config.isAutoTenantKey is true.
delete process.env.BEEFLOW_TENANT_KEY;
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-tp-'));
process.env.APP_PERSISTENT_STORAGE = storage;
// A cached tenant key, as a prior successful bootstrap would have written.
fs.writeFileSync(path.join(storage, 'tenant-key.json'),
    JSON.stringify({ tenantKey: 'cached-key', organizationId: 'org-1', ncInstanceId: 'inst-1' }));

const tp = require('../src/taskProcessing');
const config = require('../src/config');

test('registerRoutes registers /trigger for POST (AppAPI\'s verb) as well as GET', () => {
    const routes = {};
    tp.registerRoutes({
        get: (p, h) => { routes[`GET ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
    });
    assert.ok(routes['POST /trigger'], 'AppAPI triggers via POST — the POST route must exist');
    assert.ok(routes['GET /trigger'], 'GET kept for manual/diagnostic pokes');

    let answered = null;
    routes['POST /trigger']({ query: {} }, { json: (b) => { answered = b; } });
    assert.deepEqual(answered, { status: 'ok' }, 'the trigger answers immediately');
    tp.stopPolling();
});

test('bootstrap arms the poller once the cached tenant key is loaded', async () => {
    const bootstrap = require('../src/bootstrap');
    assert.equal(config.tenantKey, null, 'precondition: no tenant key before bootstrap (auto mode)');

    let armed = 0;
    const original = tp.startPolling;
    tp.startPolling = () => { armed += 1; };
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.tenantKey, 'cached-key', 'the cache-hit path sets the tenant key');
        assert.ok(armed >= 1, 'the task-processing poller is armed after the key is set');
    } finally {
        tp.startPolling = original;
        tp.stopPolling();
    }
});
