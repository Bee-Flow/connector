// Which Bee Flow server the connector talks to is resolved once at boot from
// what the install already holds (serverChoice.js). A connected install keeps
// its server without a new step; an install that holds no choice has no server,
// and the resolver itself never writes or deletes a file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLOUD = 'https://server.beeflow.nl';
const SELF = 'http://beeflow.self.test';
const OTHER = 'http://other.beeflow.test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-choice-'));

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = CLOUD; // the literal Cloud URL: no lock, no choice
process.env.APP_PERSISTENT_STORAGE = path.join(root, 'boot');
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';
fs.mkdirSync(process.env.APP_PERSISTENT_STORAGE);

const { snapshot } = require('./support/connectorProcess');
const serverChoice = require('../src/serverChoice');
const { resolveServerChoice, applyAtBoot, envLock } = serverChoice;

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A storage directory holding the given files (name → object, or a string written as is). */
function storageWith(files = {}) {
    const dir = path.join(root, `case-${n += 1}`);
    fs.mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
}

/** Resolve, and assert that the storage directory is byte for byte what it was. */
function resolve({ env = {}, files = {}, setupConfig, isAutoTenantKey = true }) {
    const storageDir = storageWith(files);
    const before = snapshot(storageDir);
    const stored = setupConfig === undefined ? (files['setup-config.json'] ?? null) : setupConfig;
    const choice = resolveServerChoice({ env, storageDir, setupConfig: stored, isAutoTenantKey });
    assert.deepEqual(snapshot(storageDir), before, 'the resolver wrote, changed or deleted a file');
    return choice;
}

const BOUND = { tenantKey: 'k', organizationId: 'org-1', ncInstanceId: 'inst-1' };
const ERROR_FILE = { status: 'failed', category: 'saas_unreachable', phase: 'saas_post', error: 'fetch failed' };
const PENDING_FILE = {
    kind: 'verification', pendingId: 'p-1', verifyUrl: '/auth/connector/bootstrap/pending/p-1/verify',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), apiBaseUrl: CLOUD,
};

// ── The five rules ───────────────────────────────────────────────────────────

test('rule 1: the word `cloud` in the env locks the connector to Bee Flow Cloud', () => {
    for (const value of ['cloud', 'CLOUD', ' Cloud ']) {
        assert.deepEqual(resolve({ env: { BEEFLOW_API_BASE_URL: value } }),
            { url: CLOUD, source: 'env-lock', locked: true }, value);
    }
});

test('rule 1: a server URL in the env is a lock, ahead of a binding and a saved choice', () => {
    const choice = resolve({
        env: { BEEFLOW_API_BASE_URL: `${SELF}/` },
        files: {
            'tenant-key.json': { ...BOUND, boundApiBaseUrl: OTHER },
            'setup-config.json': { mode: 'self-hosted', apiBaseUrl: OTHER },
        },
    });
    assert.deepEqual(choice, { url: SELF, source: 'env-lock', locked: true });
});

test('rule 1: an invalid env value is treated as unset', () => {
    for (const value of ['not a url', 'ftp://beeflow.example', 'http://169.254.169.254', 'https://user:pw@beeflow.example']) {
        assert.ok(envLock(value).invalid, `${value} is reported as invalid`);
        assert.deepEqual(resolve({ env: { BEEFLOW_API_BASE_URL: value } }),
            { url: null, source: 'none', locked: false }, value);
    }
});

test('rule 1 skips the literal Cloud URL: it is not a lock', () => {
    for (const value of [CLOUD, `${CLOUD}/`, 'https://SERVER.beeflow.nl']) {
        const lock = envLock(value);
        assert.equal(lock.url, null, value);
        assert.equal(lock.legacyCloud, true, value);
        assert.equal(lock.invalid, null, value);
    }
});

test('rule 2: a binding resolves to the server that issued it, ahead of the saved choice', () => {
    const choice = resolve({
        env: { BEEFLOW_API_BASE_URL: CLOUD },
        files: {
            'tenant-key.json': { ...BOUND, boundApiBaseUrl: `${SELF}/` },
            'setup-config.json': { mode: 'self-hosted', apiBaseUrl: OTHER },
        },
    });
    assert.deepEqual(choice, { url: SELF, source: 'binding', locked: false });
});

test('rule 2 applies in auto-key mode only: an explicit key ignores tenant-key.json', () => {
    const choice = resolve({
        env: {},
        files: { 'tenant-key.json': { ...BOUND, boundApiBaseUrl: SELF } },
        isAutoTenantKey: false,
    });
    assert.deepEqual(choice, { url: null, source: 'none', locked: false });
});

test('rule 3: a saved choice without a binding', () => {
    const choice = resolve({ env: {}, files: { 'setup-config.json': { mode: 'self-hosted', apiBaseUrl: `${SELF}/` } } });
    assert.deepEqual(choice, { url: SELF, source: 'picker', locked: false });
});

test('rule 3 comes before rule 4: a saved choice wins over the literal Cloud URL next to an explicit key', () => {
    const choice = resolve({
        env: { BEEFLOW_API_BASE_URL: CLOUD },
        files: { 'setup-config.json': { mode: 'self-hosted', apiBaseUrl: SELF } },
        isAutoTenantKey: false,
    });
    assert.deepEqual(choice, { url: SELF, source: 'picker', locked: false });
});

test('rule 4: an explicit tenant key next to the literal Cloud URL is an organisation on Bee Flow Cloud', () => {
    assert.deepEqual(resolve({ env: { BEEFLOW_API_BASE_URL: CLOUD }, isAutoTenantKey: false }),
        { url: CLOUD, source: 'legacy-env-key', locked: false });
});

test('rule 5: nothing held means no server', () => {
    assert.deepEqual(resolve({ env: {} }), { url: null, source: 'none', locked: false });
    assert.deepEqual(resolve({ env: { BEEFLOW_API_BASE_URL: '' } }), { url: null, source: 'none', locked: false });
});

test('the literal Cloud URL in the env is never a choice for an install without a key', () => {
    assert.deepEqual(resolve({ env: { BEEFLOW_API_BASE_URL: CLOUD } }), { url: null, source: 'none', locked: false });
});

// ── Existing installs (every row of the upgrade table) ───────────────────────

test('existing install: auto-bootstrapped with a bound server keeps that server', () => {
    assert.deepEqual(
        resolve({ env: { BEEFLOW_API_BASE_URL: CLOUD }, files: { 'tenant-key.json': { ...BOUND, boundApiBaseUrl: CLOUD } } }),
        { url: CLOUD, source: 'binding', locked: false });
});

test('existing install: a cache without a bound server resolves to the saved choice, else Bee Flow Cloud', () => {
    assert.deepEqual(
        resolve({ env: { BEEFLOW_API_BASE_URL: CLOUD }, files: { 'tenant-key.json': BOUND } }),
        { url: CLOUD, source: 'legacy-binding', locked: false });
    assert.deepEqual(
        resolve({
            env: { BEEFLOW_API_BASE_URL: CLOUD },
            files: { 'tenant-key.json': BOUND, 'setup-config.json': { mode: 'self-hosted', apiBaseUrl: SELF } },
        }),
        { url: SELF, source: 'legacy-binding', locked: false });
});

test('existing install: a real env lock is unchanged', () => {
    assert.deepEqual(
        resolve({ env: { BEEFLOW_API_BASE_URL: SELF }, files: { 'tenant-key.json': { ...BOUND, boundApiBaseUrl: SELF } } }),
        { url: SELF, source: 'env-lock', locked: true });
});

test('existing install: the picker or the settings form was used', () => {
    // Bound after the choice: the binding names the same server.
    assert.deepEqual(
        resolve({
            env: { BEEFLOW_API_BASE_URL: CLOUD },
            files: {
                'tenant-key.json': { ...BOUND, boundApiBaseUrl: SELF },
                'setup-config.json': { mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: 'http://web.test' },
            },
        }),
        { url: SELF, source: 'binding', locked: false });
    // Chosen, waiting for the e-mailed code: no key yet, the choice stands.
    assert.deepEqual(
        resolve({
            env: { BEEFLOW_API_BASE_URL: CLOUD },
            files: { 'setup-config.json': { mode: 'cloud', apiBaseUrl: CLOUD }, 'pending-bootstrap.json': PENDING_FILE },
        }),
        { url: CLOUD, source: 'picker', locked: false });
});

test('existing install: a pasted key with no server URL at all has no server', () => {
    assert.deepEqual(resolve({ env: {}, isAutoTenantKey: false }), { url: null, source: 'none', locked: false });
});

test('existing install: one that never connected has no server, whatever it left on disk', () => {
    const choice = resolve({
        env: { BEEFLOW_API_BASE_URL: CLOUD },
        files: { 'bootstrap-last-error.json': ERROR_FILE, 'pending-bootstrap.json': PENDING_FILE },
    });
    assert.deepEqual(choice, { url: null, source: 'none', locked: false });
});

test('existing install: an unreadable or keyless tenant-key.json is no binding', () => {
    for (const content of ['{ not json', '', '{}', '{"tenantKey":""}', '[]', 'null']) {
        assert.deepEqual(
            resolve({ env: { BEEFLOW_API_BASE_URL: CLOUD }, files: { 'tenant-key.json': content } }),
            { url: null, source: 'none', locked: false }, JSON.stringify(content));
        assert.deepEqual(
            resolve({
                env: { BEEFLOW_API_BASE_URL: CLOUD },
                files: { 'tenant-key.json': content, 'setup-config.json': { mode: 'self-hosted', apiBaseUrl: SELF } },
            }),
            { url: SELF, source: 'picker', locked: false }, JSON.stringify(content));
    }
});

test('a storage directory that does not exist resolves to no server and is not created', () => {
    const missing = path.join(root, 'never-created');
    assert.deepEqual(
        resolveServerChoice({ env: {}, storageDir: missing, setupConfig: null, isAutoTenantKey: true }),
        { url: null, source: 'none', locked: false });
    assert.equal(fs.existsSync(missing), false);
});

// ── applyAtBoot: the choice on the live config, and the key invariant ────────

/** A stand-in for the config object, as config.js builds it for the given env. */
function fakeConfig({ storageDir, envTenantKey = null, apiBaseUrl = null }) {
    return {
        persistentStorage: storageDir,
        isAutoTenantKey: envTenantKey === null,
        envTenantKey,
        tenantKey: apiBaseUrl ? envTenantKey : null,
        apiBaseUrl,
        serverSource: apiBaseUrl ? 'env-lock' : 'none',
    };
}

function withEnv(value, fn) {
    const before = process.env.BEEFLOW_API_BASE_URL;
    process.env.BEEFLOW_API_BASE_URL = value;
    try { return fn(); } finally { process.env.BEEFLOW_API_BASE_URL = before; }
}

test('applyAtBoot: no server means no tenant key in memory, also with an explicit key', () => {
    const config = fakeConfig({ storageDir: storageWith(), envTenantKey: 'pasted-key' });
    config.tenantKey = 'pasted-key'; // whatever was there
    const choice = withEnv('', () => applyAtBoot(config, null));
    assert.equal(choice.source, 'none');
    assert.equal(config.apiBaseUrl, null);
    assert.equal(config.serverSource, 'none');
    assert.equal(config.tenantKey, null);
    assert.equal(config.envTenantKey, 'pasted-key', 'the explicit key is kept aside for the moment a server is chosen');
});

test('applyAtBoot: an explicit key is applied once a server resolved', () => {
    const config = fakeConfig({ storageDir: storageWith(), envTenantKey: 'pasted-key' });
    withEnv(CLOUD, () => applyAtBoot(config, null));
    assert.equal(config.apiBaseUrl, CLOUD);
    assert.equal(config.serverSource, 'legacy-env-key');
    assert.equal(config.tenantKey, 'pasted-key');
});

test('applyAtBoot: in auto mode the server is set and the key stays for the bootstrap to load', () => {
    const storageDir = storageWith({ 'tenant-key.json': { ...BOUND, boundApiBaseUrl: SELF } });
    const config = fakeConfig({ storageDir });
    withEnv(CLOUD, () => applyAtBoot(config, null));
    assert.equal(config.apiBaseUrl, SELF);
    assert.equal(config.serverSource, 'binding');
    assert.equal(config.tenantKey, null);
});

test('applyAtBoot: a saved choice is applied', () => {
    const config = fakeConfig({ storageDir: storageWith() });
    withEnv(CLOUD, () => applyAtBoot(config, { mode: 'self-hosted', apiBaseUrl: SELF }));
    assert.equal(config.apiBaseUrl, SELF);
    assert.equal(config.serverSource, 'picker');
});

// ── The cache from before the bound server was recorded ──────────────────────

test('a binding without a bound server loads without a request, and the file names its server from then on', async () => {
    const storage = process.env.APP_PERSISTENT_STORAGE;
    const cacheFile = path.join(storage, 'tenant-key.json');
    fs.writeFileSync(cacheFile, JSON.stringify(BOUND));
    const config = require('../src/config');
    const setupConfig = require('../src/setupConfig');
    const bootstrap = require('../src/bootstrap');
    const { installFakeWorld } = require('./support/fakeWorld');

    const choice = applyAtBoot(config, setupConfig.init(storage));
    assert.deepEqual(choice, { url: CLOUD, source: 'legacy-binding', locked: false });
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).boundApiBaseUrl, undefined, 'resolving wrote nothing');

    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, CLOUD);
        assert.equal(config.tenantKey, 'k');
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.equal(cache.boundApiBaseUrl, CLOUD);
        assert.equal(cache.tenantKey, 'k');
        assert.equal(cache.organizationId, 'org-1');
        assert.equal(world.count((c) => !c.url.startsWith('http://nc.test/')), 0, 'no request to a Bee Flow server');
        assert.equal(world.count((c) => /\/auth\/connector\/bootstrap/.test(c.url)), 0);
    } finally {
        world.restore();
    }
});
