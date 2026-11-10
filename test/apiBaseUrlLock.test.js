// BEEFLOW_API_BASE_URL fixes the Bee Flow server when it is the word `cloud` or
// the URL of a server: that is the admin's lock. The literal Cloud URL is not a
// lock and by itself not a choice (AppAPI replays the value it stored at
// install time), so it leaves the admin settings form and the bound-server pin
// to do their job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLOUD = 'https://server.beeflow.nl';
const SELF = 'http://beeflow.self.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-lock-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_API_BASE_URL = CLOUD; // the literal Cloud URL: no lock, no choice

const { installFakeWorld, ocs } = require('./support/fakeWorld');

/** Fresh modules, booted the way server.js boots them. */
function freshModules() {
    for (const m of ['config', 'bootstrap', 'declarativeSettings', 'setupConfig', 'serverChoice']) {
        delete require.cache[require.resolve(`../src/${m}`)];
    }
    const config = require('../src/config');
    const setupConfig = require('../src/setupConfig');
    const choice = require('../src/serverChoice').applyAtBoot(config, setupConfig.init(storage));
    return {
        config,
        setupConfig,
        choice,
        bootstrap: require('../src/bootstrap'),
        declarativeSettings: require('../src/declarativeSettings'),
    };
}

function clearStorage() {
    for (const f of fs.readdirSync(storage)) fs.rmSync(path.join(storage, f), { force: true });
}

function bindTo(server, tenantKey) {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey, organizationId: 'org-1', ncInstanceId: 'inst-1', boundApiBaseUrl: server,
    }));
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('the env value at load: unset and the literal Cloud URL give no server; `cloud` and a URL are locks', () => {
    const cases = [
        // [value, server at load, locked]
        ['', null, false],
        [CLOUD, null, false],
        [`${CLOUD}/`, null, false],
        ['cloud', CLOUD, true],
        ['Cloud', CLOUD, true],
        [SELF, SELF, true],
        [`${SELF}/`, SELF, true],
        ['not a url', null, false],
        ['http://169.254.169.254', null, false],
    ];
    for (const [value, server, locked] of cases) {
        process.env.BEEFLOW_API_BASE_URL = value;
        delete require.cache[require.resolve('../src/config')];
        const config = require('../src/config');
        const label = `BEEFLOW_API_BASE_URL=${value || '(unset)'}`;
        assert.equal(config.apiBaseUrl, server, label);
        assert.equal(config.apiBaseUrlLocked, locked, label);
        assert.equal(config.tenantKey, null, `${label}: auto mode holds no key at load`);
    }
    process.env.BEEFLOW_API_BASE_URL = CLOUD;
});

test('an explicit tenant key is in memory at load only when the env also fixes the server', () => {
    process.env.BEEFLOW_TENANT_KEY = 'pasted-key';
    try {
        for (const [value, key] of [['', null], [CLOUD, null], ['cloud', 'pasted-key'], [SELF, 'pasted-key']]) {
            process.env.BEEFLOW_API_BASE_URL = value;
            delete require.cache[require.resolve('../src/config')];
            const config = require('../src/config');
            assert.equal(config.tenantKey, key, `BEEFLOW_API_BASE_URL=${value || '(unset)'}`);
            assert.equal(config.envTenantKey, 'pasted-key');
        }
    } finally {
        process.env.BEEFLOW_TENANT_KEY = 'auto';
        process.env.BEEFLOW_API_BASE_URL = CLOUD;
    }
});

test('the admin settings form switches a Cloud-bound install to a self-hosted server despite the literal Cloud URL in the env', async () => {
    clearStorage();
    bindTo(CLOUD, 'cloud-key');
    const { config, bootstrap, declarativeSettings, setupConfig } = freshModules();
    const world = installFakeWorld({
        servers: { [SELF]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'self-key', organizationId: 'org-self' }) } },
        nc: (method, url) => (url.includes('/ex-app/config/get-values')
            ? ocs([{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: SELF }])
            : undefined),
    });
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, CLOUD);
        assert.equal(config.tenantKey, 'cloud-key');

        await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(config.apiBaseUrl, SELF);
        assert.equal(config.tenantKey, 'self-key');
        assert.equal(setupConfig.get()?.apiBaseUrl, SELF);
    } finally {
        world.restore();
    }
});

test('a cache bound to a self-hosted server pins the connector there at boot', async () => {
    clearStorage();
    bindTo(SELF, 'self-key');
    const { config, bootstrap, choice } = freshModules();
    assert.deepEqual(choice, { url: SELF, source: 'binding', locked: false });
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, SELF, 'the key belongs to the self-hosted server; Cloud would reject it');
        assert.equal(config.tenantKey, 'self-key');
        assert.equal(world.count((c) => !c.url.startsWith('http://nc.test/')), 0, 'loading a binding contacts no Bee Flow server');
    } finally {
        world.restore();
    }
});

test('a real lock still wins over the bound-server pin', async () => {
    clearStorage();
    bindTo(SELF, 'self-key');
    process.env.BEEFLOW_API_BASE_URL = 'http://locked.test';
    const { config, bootstrap, choice } = freshModules();
    assert.deepEqual(choice, { url: 'http://locked.test', source: 'env-lock', locked: true });
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, 'http://locked.test');
    } finally {
        world.restore();
        process.env.BEEFLOW_API_BASE_URL = CLOUD;
    }
});

test('the word `cloud` locks the connector to Bee Flow Cloud', async () => {
    clearStorage();
    process.env.BEEFLOW_API_BASE_URL = 'cloud';
    const { config, declarativeSettings, choice } = freshModules();
    assert.deepEqual(choice, { url: CLOUD, source: 'env-lock', locked: true });
    const world = installFakeWorld({
        nc: (method, url) => (url.includes('/ex-app/config/get-values')
            ? ocs([{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: SELF }])
            : undefined),
    });
    try {
        await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(config.apiBaseUrl, CLOUD, 'the settings form does not move a locked install');
        assert.equal(world.calls.length, 0, 'a locked install does not even read the form');
    } finally {
        world.restore();
        process.env.BEEFLOW_API_BASE_URL = CLOUD;
    }
});
