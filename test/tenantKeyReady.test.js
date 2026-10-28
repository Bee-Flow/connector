// What has to happen when a tenant key becomes active after boot.
//
//   H7  The Assistant (Task Processing) providers and the Files actions used
//       to register only inside the boot-time /init run, which bails out
//       without a key. A key that arrived later (an emailed code entered by
//       the admin) left Nextcloud with neither until a restart.
//   M3  The webhook rows' secret derives from the key. A CHANGED key left
//       every row sending the old secret, so all push triggers got 401.
//   M2  A failed first bootstrap (Bee Flow down at boot) was never retried.
//
// Real modules throughout; only the network is replaced (support/fakeWorld).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAAS = 'http://beeflow.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-keyready-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = SAAS;
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '40';

const { installFakeWorld, json } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const { registerTenantKeyDependents } = require('../src/heartbeat'); // subscribes the key-dependent registrations
const { TASK_TYPES } = require('../src/taskProcessing');

const isProviderPost = (c) => c.method === 'POST' && c.url.endsWith('/api/v1/ai_provider/task_processing');
const isFilesActionPost = (c) => c.method === 'POST' && c.url.endsWith('/api/v2/ui/files-actions-menu');
const isWebhookUpsert = (c) => c.method === 'POST' && /\/webhook_listeners\/api\/v1\/webhooks(\/\d+)?$/.test(c.url);

/** @param {() => boolean} cond */
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
        await new Promise((r) => setTimeout(r, 10));
    }
}

const secretFor = (key) => crypto.createHmac('sha256', key).update('beeflow:webhook-listener:v1').digest('hex');

// Let the background work a key started run to its end before the next test
// resets the state. Seeing config.tenantKey change is not enough: the provision
// that set it is still finishing (cache, error file), and a bootstrapIfNeeded()
// in the next test would JOIN that run and resolve instead of failing. Both
// calls join what is in flight, so they wait for exactly that work.
async function settle() {
    await bootstrap.bootstrapIfNeeded().catch(() => {});
    await registerTenantKeyDependents();
}

function reset() {
    for (const f of fs.readdirSync(storage)) fs.rmSync(path.join(storage, f), { force: true });
    config.tenantKey = null;
    config.organizationId = null;
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('H7: a key that arrives with the emailed code registers the Assistant providers and Files actions', async () => {
    reset();
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                'POST /auth/connector/bootstrap': () => json({
                    code: 'email_verification_required', pendingId: 'p1', verifyUrl: '/auth/connector/bootstrap/pending/p1/verify',
                    expiresAt: new Date(Date.now() + 600_000).toISOString(), maskedEmail: 'a***@nc.test',
                }, 202),
                'POST /auth/connector/bootstrap/pending/p1/verify': () => ({ tenantKey: 'key-A', organizationId: 'org-1' }),
            },
        },
    });
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.tenantKey, null);
        assert.equal(bootstrap.getPendingState()?.status, 'awaiting_email_verification');
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(world.count(isProviderPost), 0, 'nothing registers without a key');

        await bootstrap.submitVerificationCode('123456');
        assert.equal(config.tenantKey, 'key-A');
        await until(() => world.count(isProviderPost) >= TASK_TYPES.length
            && world.count(isFilesActionPost) >= 3 && world.count(isWebhookUpsert) > 0);
        assert.equal(world.count(isProviderPost), TASK_TYPES.length);
        assert.equal(world.count(isFilesActionPost), 3);
        await settle();
    } finally {
        world.restore();
    }
});

test('M3: a changed key re-registers the webhook rows with the new secret', async () => {
    // Continues from key-A above. Clear-cache binds to a fresh org with key-B.
    assert.equal(config.tenantKey, 'key-A');
    const world = installFakeWorld({
        servers: { [SAAS]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'key-B', organizationId: 'org-2' }) } },
    });
    try {
        await bootstrap.invalidateAndRebootstrap();
        assert.equal(config.tenantKey, 'key-B');
        await until(() => world.count(isWebhookUpsert) > 0);
        await new Promise((r) => setTimeout(r, 30));
        const secrets = new Set(world.calls.filter(isWebhookUpsert)
            .map((c) => JSON.parse(c.body).authData['X-Beeflow-Hook-Secret']));
        assert.deepEqual([...secrets], [secretFor('key-B')]);
        await settle();
    } finally {
        world.restore();
    }
});

test('M2: a first bootstrap that fails on the network is retried by itself', async () => {
    reset();
    let attempts = 0;
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                'POST /auth/connector/bootstrap': () => {
                    attempts += 1;
                    if (attempts === 1) throw new TypeError('fetch failed');
                    return { tenantKey: 'key-C', organizationId: 'org-3' };
                },
            },
        },
    });
    try {
        await assert.rejects(bootstrap.bootstrapIfNeeded(), /fetch failed/);
        assert.equal(config.tenantKey, null);
        assert.ok(bootstrap.getLastErrorState()?.nextRetryAt, 'diagnostics announce a retry that will really happen');
        await until(() => config.tenantKey === 'key-C');
        assert.equal(attempts, 2);
        // ...and the key-dependent registrations follow, without /init.
        await until(() => world.count(isProviderPost) >= TASK_TYPES.length);
        await settle();
    } finally {
        world.restore();
    }
});

test('M2: a rejection the admin has to fix is not retried', async () => {
    reset();
    let attempts = 0;
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                'POST /auth/connector/bootstrap': () => { attempts += 1; return json({ error: 'pairing required', code: 'pairing_required' }, 403); },
            },
        },
    });
    try {
        await assert.rejects(bootstrap.bootstrapIfNeeded(), /HTTP 403/);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(attempts, 1);
        assert.equal(bootstrap.getLastErrorState()?.nextRetryAt, null);
    } finally {
        world.restore();
    }
});
