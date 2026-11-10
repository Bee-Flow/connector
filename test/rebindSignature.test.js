// A re-bootstrap of an existing binding (clear cache, new public URL) must
// prove the binding with the tenant key it held: the server releases the key
// only to a bootstrap signed with it (X-Beeflow-Sig). A switch to another
// server never carries a signature made with the old server's key.
//
// Every test starts the way an install that is already connected starts: a
// tenant-key cache bound to OLD on disk, resolved by serverChoice.applyAtBoot
// (no install-time server), and the key loaded from that cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OLD = 'http://old.beeflow.test';
const NEW = 'http://new.beeflow.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-rebind-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
delete process.env.BEEFLOW_API_BASE_URL; // no install-time server: the binding on disk names it
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const { installFakeWorld } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');

async function boundToOld() {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'old-key', organizationId: 'org-old', ncInstanceId: 'inst-1', boundApiBaseUrl: OLD,
    }));
    // The boot: the binding names the server, the cache gives the key.
    const choice = serverChoice.applyAtBoot(config, null);
    assert.deepEqual(choice, { url: OLD, source: 'binding', locked: false });
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(world.calls.length, 0, 'a connected install asks for nothing at boot');
    } finally {
        world.restore();
    }
    assert.equal(config.tenantKey, 'old-key');
}

/** @param {{ headers: Record<string, string>, body: string | null }} call */
function verify(call, key) {
    const [ts, sig] = String(call.headers['X-Beeflow-Sig'] || '').split('.');
    const expected = crypto.createHmac('sha256', key).update(`${ts}\nPOST\n/auth/connector/bootstrap\n${call.body}`).digest('hex');
    return sig === expected && Math.abs(Date.now() / 1000 - Number(ts)) < 60;
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('a re-bootstrap on the same server is signed with the key it held', async () => {
    await boundToOld();
    const world = installFakeWorld({
        servers: { [OLD]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'old-key', organizationId: 'org-old' }) } },
    });
    try {
        assert.deepEqual(await bootstrap.invalidateAndRebootstrap(), { status: 'bound' });
        const calls = world.calls.filter(c => c.url === `${OLD}/auth/connector/bootstrap`);
        assert.equal(calls.length, 1);
        assert.ok(verify(calls[0], 'old-key'), 'X-Beeflow-Sig must verify against the held tenant key and the sent body');
    } finally {
        world.restore();
    }
});

test('a switch to another server sends no signature made with the old key', async () => {
    await boundToOld();
    const world = installFakeWorld({
        servers: { [NEW]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'new-key', organizationId: 'org-new' }) } },
    });
    try {
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: NEW });
        const call = world.calls.find(c => c.url === `${NEW}/auth/connector/bootstrap`);
        assert.ok(call);
        assert.equal(call.headers['X-Beeflow-Sig'], undefined);
    } finally {
        world.restore();
    }
});

test('a later first-time bootstrap carries no signature', async () => {
    // A server is chosen, but nothing is bound to it yet.
    fs.rmSync(path.join(storage, 'tenant-key.json'), { force: true });
    const choice = serverChoice.applyAtBoot(config, { apiBaseUrl: OLD });
    assert.deepEqual(choice, { url: OLD, source: 'picker', locked: false });
    assert.equal(config.tenantKey, null);
    const world = installFakeWorld({
        servers: { [OLD]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'k2', organizationId: 'org-2' }) } },
    });
    try {
        await bootstrap.bootstrapIfNeeded();
        const call = world.calls.find(c => c.url === `${OLD}/auth/connector/bootstrap`);
        assert.ok(call);
        assert.equal(call.headers['X-Beeflow-Sig'], undefined);
    } finally {
        world.restore();
    }
});
