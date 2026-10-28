// Unconfirmed #6: invalidateAndRebootstrap clears the single-flight guard, so a
// provision that was still waiting on its server (the boot run, a retry) could
// finish AFTER the admin's switch and overwrite the newer key and cache with
// the abandoned target's answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OLD = 'http://old.beeflow.test';
const NEW = 'http://new.beeflow.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-race-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = OLD;
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const { installFakeWorld } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('a slow provision for the old server cannot overwrite the binding of a newer switch', async () => {
    let releaseOld;
    const oldAnswered = new Promise((r) => { releaseOld = r; });
    const world = installFakeWorld({
        servers: {
            [OLD]: { 'POST /auth/connector/bootstrap': async () => { await oldAnswered; return { tenantKey: 'old-key', organizationId: 'org-old' }; } },
            [NEW]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'new-key', organizationId: 'org-new' }) },
        },
    });
    try {
        const boot = bootstrap.bootstrapIfNeeded(); // the boot run, stuck on the old server
        await new Promise((r) => setTimeout(r, 20));
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: NEW });
        assert.equal(config.tenantKey, 'new-key');
        releaseOld();
        await boot;
        assert.equal(config.tenantKey, 'new-key');
        assert.equal(config.apiBaseUrl, NEW);
        const cached = JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8'));
        assert.equal(cached.tenantKey, 'new-key');
    } finally {
        world.restore();
    }
});
