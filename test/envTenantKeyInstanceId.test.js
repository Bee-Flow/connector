// An install-time tenant key (BEEFLOW_TENANT_KEY) comes without the instance
// id a key from the bootstrap is stored with. Everything the connector signs
// for the Bee Flow server names that id (push-trigger events, Talk messages,
// Assistant tasks, the app menu), so the connector reads it from Nextcloud the
// way the bootstrap does. Nothing is asked of the Bee Flow server for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const SELF = 'http://beeflow.self.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-envkey-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'pasted-key';
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const { installFakeWorld, json } = require('./support/fakeWorld');

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

/** Fresh modules, booted the way server.js boots them. */
function boot(apiBaseUrlEnv, stored) {
    if (apiBaseUrlEnv) process.env.BEEFLOW_API_BASE_URL = apiBaseUrlEnv;
    else delete process.env.BEEFLOW_API_BASE_URL;
    for (const f of fs.readdirSync(storage)) fs.rmSync(path.join(storage, f), { recursive: true, force: true });
    if (stored) fs.writeFileSync(path.join(storage, 'setup-config.json'), JSON.stringify(stored));
    for (const m of ['config', 'bootstrap', 'setupConfig', 'serverChoice', 'automationEventsWebhook', 'webhookListeners']) {
        delete require.cache[require.resolve(`../src/${m}`)];
    }
    const config = require('../src/config');
    const setupConfig = require('../src/setupConfig');
    require('../src/serverChoice').applyAtBoot(config, setupConfig.init(storage));
    return { config, bootstrap: require('../src/bootstrap') };
}

const toBeeFlow = (c) => c.url.startsWith(SELF);

test('a key next to a server fixed at install time: the instance id is read from Nextcloud', async () => {
    const { config, bootstrap } = boot(SELF);
    assert.equal(config.tenantKey, 'pasted-key');
    assert.equal(config.ncInstanceId, null);
    const world = installFakeWorld();
    let ready = 0;
    bootstrap.onTenantKeyReady(() => { ready += 1; });
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.ncInstanceId, 'inst-1');
        assert.equal(ready, 1, 'what waits for the key and the id is started once');
        assert.equal(world.count(toBeeFlow), 0, 'no request to the Bee Flow server');
        await bootstrap.bootstrapIfNeeded();
        assert.equal(ready, 1, 'a later run starts nothing again');
        assert.equal(world.count((c) => c.url.includes('/cloud/capabilities')), 1, 'Nextcloud is asked once');
    } finally {
        world.restore();
    }
});

test('a key whose server an administrator chose: the id is known when the key is taken into use', async () => {
    const { config, bootstrap } = boot(null, { mode: 'self-hosted', apiBaseUrl: SELF });
    assert.equal(config.apiBaseUrl, SELF);
    // As after a re-bootstrap dropped the key from memory.
    config.tenantKey = null;
    const world = installFakeWorld();
    let idWhenReady;
    bootstrap.onTenantKeyReady(() => { idWhenReady = config.ncInstanceId; });
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.tenantKey, 'pasted-key');
        assert.equal(idWhenReady, 'inst-1');
        assert.equal(world.count(toBeeFlow), 0);
    } finally {
        world.restore();
    }
});

test('Nextcloud not answering yet leaves the key in use; the id follows on a later run', async () => {
    const { config, bootstrap } = boot(SELF);
    let down = true;
    const world = installFakeWorld({
        nc: (_method, url) => (down && url.includes('/cloud/capabilities') ? json({ error: 'starting' }, 503) : undefined),
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.tenantKey, 'pasted-key');
        assert.equal(config.ncInstanceId, null);
        down = false;
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.ncInstanceId, 'inst-1');
    } finally {
        console.warn = warn;
        world.restore();
    }
});

test('a push-trigger delivery on an install-time key is forwarded with the instance id', async () => {
    const { config, bootstrap } = boot(SELF);
    const forwarded = [];
    const world = installFakeWorld({
        servers: { [SELF]: { 'POST /api/automation/events/nextcloud': (init) => { forwarded.push(init.headers); return { ok: true }; } } },
    });
    const hook = require('../src/automationEventsWebhook');
    const wl = require('../src/webhookListeners');
    const app = express();
    app.use('/', hook);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        await bootstrap.bootstrapIfNeeded();
        const body = JSON.stringify({
            event: { class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', node: { id: 7, path: '/alice/files/a.txt' } },
            user: { uid: 'alice', displayName: 'Alice' },
            time: 1,
        });
        const answer = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: server.address().port, path: wl.HOOK_PATH, method: 'POST',
                headers: { 'content-length': Buffer.byteLength(body), 'x-beeflow-hook-secret': wl.hookSecret() },
            }, (res) => {
                let text = '';
                res.on('data', (c) => { text += c; });
                res.on('end', () => resolve({ status: res.statusCode, text }));
            });
            req.on('error', reject);
            req.end(body);
        });
        assert.equal(answer.status, 200, answer.text);
        assert.equal(forwarded.length, 1);
        assert.equal(forwarded[0]['X-Beeflow-NC-Instance-Id'], 'inst-1');
        assert.equal(config.ncInstanceId, 'inst-1');
    } finally {
        server.close();
        world.restore();
    }
});
