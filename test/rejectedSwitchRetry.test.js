// A connected install and the bootstrap's own retry.
//
// The retry exists for an install without a key (a first bootstrap that got no
// answer). An install that holds a binding goes back to it when a re-bootstrap
// fails (a switch to a server that does not answer, a cache clear while the
// server is down): nothing is tried again afterwards, the server in use is not
// asked for a new binding, and no failure with a "next retry" stays on record.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWN = 'https://bee-flow.example';
const DOWN = 'https://nowhere.example';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-rejected-retry-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
delete process.env.BEEFLOW_API_BASE_URL;
process.env.APP_PERSISTENT_STORAGE = storage;
// The retry is on, and due at once: whatever is armed fires within the test.
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '1';

const { installFakeWorld } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');

const BINDING = { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN, provisionedAt: '2026-01-01T00:00:00.000Z' };
const down = () => { throw new TypeError('fetch failed'); };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectedInstall() {
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify(BINDING));
    serverChoice.applyAtBoot(config, setupConfig.init(storage));
    await bootstrap.bootstrapIfNeeded();
    assert.equal(config.tenantKey, 'own-key');
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('a switch that does not happen arms no retry: the server in use gets no bootstrap request and keeps a clean record', async () => {
    await connectedInstall();
    // The server in use would refuse a bootstrap that does not prove the binding.
    const world = installFakeWorld({
        servers: {
            [OWN]: { 'POST /auth/connector/bootstrap': () => new Response(JSON.stringify({ error: 'already bound', code: 'NC_REBIND_PROOF_REQUIRED' }), { status: 403 }) },
            [DOWN]: { 'POST /auth/connector/bootstrap': down },
        },
    });
    try {
        for (let i = 0; i < 3; i++) {
            const err = await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: DOWN }).catch((e) => e);
            assert.ok(err instanceof Error, 'the switch failed');
            assert.equal(bootstrap._bootstrapRetryArmedForTests(), false, 'no retry is waiting');
            await tick(15); // longer than the retry delay
        }
        assert.equal(world.count((c) => c.url.startsWith(`${OWN}/`)), 0, 'nothing was asked of the server in use');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(bootstrap.getLastErrorState(), null);
        assert.equal(fs.existsSync(path.join(storage, 'bootstrap-last-error.json')), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8')).tenantKey, 'own-key');
        assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, DOWN);
        assert.equal(bootstrap.connectFailed(), false);
    } finally {
        world.restore();
    }
});

test('a re-bootstrap on the same server that gets no answer keeps the key and schedules nothing', async () => {
    await connectedInstall();
    const world = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': down } } });
    try {
        const err = await bootstrap.invalidateAndRebootstrap().catch((e) => e);
        assert.ok(err instanceof Error);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(bootstrap._bootstrapRetryArmedForTests(), false);
        await tick(15);
        assert.equal(world.count((c) => c.url === `${OWN}/auth/connector/bootstrap`), 1, 'one attempt, no retry');
        assert.equal(bootstrap.getLastErrorState()?.nextRetryAt, null, 'the record names no next attempt');
        assert.equal(bootstrap.connectFailed(), false, 'a key is held: the app is served as before');
    } finally {
        world.restore();
    }
});

test('an install without a key still retries a first connect that got no answer', async () => {
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    setupConfig.init(storage);
    setupConfig.clear();
    serverChoice.applyAtBoot(config, setupConfig.get());
    config.tenantKey = null;
    let up = false;
    const world = installFakeWorld({
        servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => (up ? { tenantKey: 'first-key', organizationId: 'org' } : down()) } },
    });
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
        try {
            await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch(() => {});
        } finally {
            console.log = realLog;
        }
        assert.ok(lines.some((l) => l.includes('no tenant key is held yet')), 'the log says what the install holds');
        assert.ok(!lines.some((l) => l.includes('Invalidated cached tenant key')), 'and names no key that was never there');
        assert.equal(config.apiBaseUrl, OWN, 'a first choice stays');
        assert.equal(config.tenantKey, null);
        // The retry is under way by itself (it may be between two attempts
        // right now); once the server answers, the next attempt connects.
        up = true;
        for (let i = 0; i < 600 && !config.tenantKey; i++) await tick(5);
        assert.equal(config.tenantKey, 'first-key');
        assert.equal(bootstrap.connectFailed(), false);
    } finally {
        world.restore();
    }
});
