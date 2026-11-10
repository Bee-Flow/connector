// Switching the Bee Flow server from /setup or the admin settings form.
//
//   H3  A failed switch from /setup puts everything back on the old server:
//       the URL, the key and the saved choice, so a restart stays there too.
//   M6  A new server that wants the emailed code first is a pending switch on
//       that server: one pending binding, verify goes there, and a switch that
//       is rolled back clears the pending state it created.
//
// Every test starts the way an install that is already connected starts: a
// tenant-key cache bound to OLD on disk, resolved by serverChoice.applyAtBoot
// (no install-time server), and the key loaded from that cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installWithStorage, NO_SERVER } = require('./support/installValues');

const OLD = 'http://old.beeflow.test';
const NEW = 'http://new.beeflow.test';
// no install-time server: the binding on disk names it
const storage = installWithStorage('bf-connector-switch-', NO_SERVER);

const { postAsAdmin, until } = require('./support/setupRequests');
const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');
const setupRouter = require('../src/setup');
const declarativeSettings = require('../src/declarativeSettings');

setupConfig.init(storage);
function readJsonOrNull(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const post = (pathname, body) => postAsAdmin(setupRouter, pathname, body);

async function boundToOld() {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'old-key', organizationId: 'org-old', ncInstanceId: 'inst-1', boundApiBaseUrl: OLD,
    }));
    fs.rmSync(path.join(storage, 'pending-bootstrap.json'), { force: true });
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: OLD });
    // The boot: the binding names the server, the cache gives the key.
    const choice = serverChoice.applyAtBoot(config, setupConfig.get());
    assert.deepEqual(choice, { url: OLD, source: 'binding', locked: false });
    assert.equal(config.tenantKey, null, 'the key comes from the cache, not from the resolver');
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(world.count((c) => c.url.includes('/auth/connector/bootstrap')), 0, 'a connected install asks for nothing at boot');
    } finally {
        world.restore();
    }
    assert.equal(config.apiBaseUrl, OLD);
    assert.equal(config.tenantKey, 'old-key');
}

const VERIFY_202 = () => json({
    code: 'email_verification_required', pendingId: 'p1',
    verifyUrl: '/auth/connector/bootstrap/pending/p1/verify',
    resendUrl: '/auth/connector/bootstrap/pending/p1/resend',
    expiresAt: new Date(Date.now() + 600_000).toISOString(), maskedEmail: 'a***@nc.test',
}, 202);

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('H3: a failed switch in /setup leaves the URL, the key and the saved choice on the old server', async () => {
    await boundToOld();
    let attempted = false;
    const world = installFakeWorld({
        servers: { [NEW]: { 'POST /auth/connector/bootstrap': () => { attempted = true; return json({ error: 'down' }, 503); } } },
    });
    try {
        const res = await post('/setup', { mode: 'self-hosted', apiBaseUrl: NEW });
        assert.equal(res.status, 200);
        await until(() => attempted && config.tenantKey === 'old-key');
        // The saved choice is restored by the setup route's catch handler, which runs
        // only after the bootstrap rollback has also deleted the pending file and
        // rewritten the key cache (atomic writes since #552): wait for that, not for
        // a fixed number of milliseconds.
        await until(() => setupConfig.get()?.apiBaseUrl === OLD);
        assert.equal(config.apiBaseUrl, OLD);
        assert.equal(config.tenantKey, 'old-key');
        assert.equal(setupConfig.get()?.apiBaseUrl, OLD, 'a restart must not move to the server that refused');
    } finally {
        world.restore();
    }
});

test('H3: a successful switch in /setup binds to the new server', async () => {
    await boundToOld();
    const world = installFakeWorld({
        servers: { [NEW]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'new-key', organizationId: 'org-new' }) } },
    });
    try {
        await post('/setup', { mode: 'self-hosted', apiBaseUrl: NEW });
        const cacheFile = path.join(storage, 'tenant-key.json');
        // The key is in memory before the switch is over; the choice is marked
        // as made on the setup page when it is.
        await until(() => config.tenantKey === 'new-key' && readJsonOrNull(cacheFile)?.boundApiBaseUrl === NEW
            && config.serverSource === 'picker');
        assert.equal(config.apiBaseUrl, NEW);
        assert.equal(setupConfig.get()?.apiBaseUrl, NEW);
        const cached = readJsonOrNull(cacheFile);
        assert.equal(cached.boundApiBaseUrl, NEW);
    } finally {
        world.restore();
    }
});

test('M6: a switch to a server that wants the emailed code is pending there, once, and verify goes there', async () => {
    await boundToOld();
    let bootstraps = 0;
    let verifiedAt = null;
    const world = installFakeWorld({
        servers: {
            [NEW]: {
                'POST /auth/connector/bootstrap': () => { bootstraps += 1; return VERIFY_202(); },
                'POST /auth/connector/bootstrap/pending/p1/verify': () => { verifiedAt = NEW; return { tenantKey: 'new-key', organizationId: 'org-new' }; },
            },
            [OLD]: {
                'POST /auth/connector/bootstrap/pending/p1/verify': () => { verifiedAt = OLD; return json({ error: 'not found' }, 404); },
            },
        },
        nc: (method, url) => (url.includes('/ex-app/config/get-values')
            ? ocs([{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: NEW }])
            : undefined),
    });
    try {
        for (let i = 0; i < 3; i++) await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(bootstraps, 1, 'one pending binding, not one per poll');
        assert.equal(config.apiBaseUrl, NEW);
        assert.equal(bootstrap.getPendingState()?.status, 'awaiting_email_verification');

        await bootstrap.submitVerificationCode('123456');
        assert.equal(verifiedAt, NEW);
        assert.equal(config.tenantKey, 'new-key');
        assert.equal(config.apiBaseUrl, NEW);
    } finally {
        world.restore();
    }
});

test('M6: a rolled-back switch clears the pending state it created', async () => {
    await boundToOld();
    const world = installFakeWorld({
        servers: {
            [NEW]: { 'POST /auth/connector/bootstrap': () => json({ error: 'nope' }, 500) },
        },
    });
    try {
        await assert.rejects(bootstrap.invalidateAndRebootstrap({ apiBaseUrl: NEW }));
        assert.equal(config.apiBaseUrl, OLD);
        assert.equal(config.tenantKey, 'old-key');
        assert.equal(bootstrap.getPendingState(), null, 'heartbeat must not report a verification the working key does not need');
        assert.equal(fs.existsSync(path.join(storage, 'pending-bootstrap.json')), false);
    } finally {
        world.restore();
    }
});
