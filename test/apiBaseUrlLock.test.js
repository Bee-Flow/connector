// AppAPI injects BEEFLOW_API_BASE_URL=https://server.beeflow.nl into every
// install (the <default> in info.xml), so "the env is set" is not an admin
// lock. Only a value naming another server is; the Cloud default must let the
// admin settings form and the bound-server pin do their job.

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
process.env.BEEFLOW_API_BASE_URL = CLOUD; // what AppAPI injects when nobody typed a value

const { installFakeWorld, ocs } = require('./support/fakeWorld');

function freshModules() {
    for (const m of ['config', 'bootstrap', 'declarativeSettings', 'setupConfig']) {
        delete require.cache[require.resolve(`../src/${m}`)];
    }
    return {
        config: require('../src/config'),
        bootstrap: require('../src/bootstrap'),
        declarativeSettings: require('../src/declarativeSettings'),
        setupConfig: require('../src/setupConfig'),
    };
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('only a non-Cloud BEEFLOW_API_BASE_URL is an admin lock', () => {
    const cases = [[CLOUD, false], [`${CLOUD}/`, false], [SELF, true], ['', false]];
    for (const [value, locked] of cases) {
        process.env.BEEFLOW_API_BASE_URL = value;
        const { config } = freshModules();
        assert.equal(config.apiBaseUrlLocked, locked, `BEEFLOW_API_BASE_URL=${value || '(unset)'}`);
        assert.equal(config.apiBaseUrl, value ? value.replace(/\/+$/, '') : CLOUD);
    }
    process.env.BEEFLOW_API_BASE_URL = CLOUD;
});

test('the admin settings form switches to a self-hosted server despite the injected Cloud default', async () => {
    process.env.BEEFLOW_API_BASE_URL = CLOUD;
    const { config, declarativeSettings, setupConfig } = freshModules();
    setupConfig.init(storage);
    config.tenantKey = 'cloud-key';
    const world = installFakeWorld({
        servers: { [SELF]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'self-key', organizationId: 'org-self' }) } },
        nc: (method, url) => (url.includes('/ex-app/config/get-values')
            ? ocs([{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: SELF }])
            : undefined),
    });
    try {
        await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(config.apiBaseUrl, SELF);
        assert.equal(config.tenantKey, 'self-key');
        assert.equal(setupConfig.get()?.apiBaseUrl, SELF);
    } finally {
        world.restore();
    }
});

test('a cache bound to a self-hosted server pins the connector there at boot', async () => {
    process.env.BEEFLOW_API_BASE_URL = CLOUD;
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'self-key', organizationId: 'org-self', ncInstanceId: 'inst-1', boundApiBaseUrl: SELF,
    }));
    const { config, bootstrap } = freshModules();
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, SELF, 'the key belongs to the self-hosted server; Cloud would reject it');
        assert.equal(config.tenantKey, 'self-key');
    } finally {
        world.restore();
    }
});

test('a real lock still wins over the bound-server pin', async () => {
    process.env.BEEFLOW_API_BASE_URL = 'http://locked.test';
    const { config, bootstrap } = freshModules();
    const world = installFakeWorld();
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, 'http://locked.test');
    } finally {
        world.restore();
        process.env.BEEFLOW_API_BASE_URL = CLOUD;
    }
});
