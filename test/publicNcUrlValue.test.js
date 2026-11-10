// BEEFLOW_NC_PUBLIC_URL fixes the public Nextcloud address only when it holds
// a URL. Any other text (a stray word, a value filled in by the deploy
// tooling) fixes nothing: it is logged and ignored, the address of the setup
// page (or NEXTCLOUD_URL) is used, and the field on the setup page is free. A
// URL does fix it: the setup page shows it and its route does not change it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-publicnc-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.APP_PERSISTENT_STORAGE = storage;
delete process.env.BEEFLOW_API_BASE_URL;

const realFetch = globalThis.fetch;
const SRC = path.join(__dirname, '..', 'src') + path.sep;
test.after(() => {
    delete process.env.BEEFLOW_NC_PUBLIC_URL;
    fs.rmSync(storage, { recursive: true, force: true });
});

/** The connector's modules loaded afresh with this BEEFLOW_NC_PUBLIC_URL. */
function loadWith(value) {
    if (value === undefined) delete process.env.BEEFLOW_NC_PUBLIC_URL;
    else process.env.BEEFLOW_NC_PUBLIC_URL = value;
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC)) delete require.cache[key];
    }
    const config = require('../src/config');
    require('../src/setupConfig').init(storage);
    return { config, setupRouter: require('../src/setup') };
}

async function call(setupRouter, method, pathname, body) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true, language: null } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const res = await realFetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
            method,
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test('a value that is not a URL is logged and ignored; the setup page field stays free', async () => {
    for (const value of ['Array', 'yes', 'ftp://files.example.org', 'cloud.example.org', '   ']) {
        const warned = [];
        const realWarn = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        let loaded;
        try { loaded = loadWith(value); } finally { console.warn = realWarn; }
        const { config, setupRouter } = loaded;
        assert.equal(config.nextcloudPublicUrl, null, `"${value}" is not used as an address`);
        assert.equal(config.nextcloudPublicUrlLocked, false, `"${value}" fixes nothing`);
        if (value.trim()) {
            assert.equal(warned.filter((l) => l.includes('ignoring BEEFLOW_NC_PUBLIC_URL')).length, 1, `"${value}" is logged once`);
        }
        const status = (await call(setupRouter, 'GET', '/setup/status')).body;
        assert.deepEqual(
            { envOverridden: status.publicNcUrl.envOverridden, envValue: status.publicNcUrl.envValue, active: status.publicNcUrl.active },
            { envOverridden: false, envValue: null, active: null },
        );
    }
});

test('a URL fixes the address: used as it is, shown as fixed, and not changed through the setup page', async () => {
    const { config, setupRouter } = loadWith('https://cloud.example.org/');
    assert.equal(config.nextcloudPublicUrl, 'https://cloud.example.org');
    assert.equal(config.nextcloudPublicUrlLocked, true);
    const status = (await call(setupRouter, 'GET', '/setup/status')).body;
    assert.equal(status.publicNcUrl.envOverridden, true);
    assert.equal(status.publicNcUrl.active, 'https://cloud.example.org');

    const refused = await call(setupRouter, 'POST', '/setup/public-nc-url', { publicNcUrl: 'https://other.example.org' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'env_locked');
    assert.equal(config.nextcloudPublicUrl, 'https://cloud.example.org', 'unchanged');
    assert.equal(require('../src/setupConfig').get()?.publicNcUrl ?? null, null, 'nothing saved');
});

test('without an install-time value the address is not fixed', () => {
    const { config } = loadWith(undefined);
    assert.equal(config.nextcloudPublicUrl, null);
    assert.equal(config.nextcloudPublicUrlLocked, false);
});
