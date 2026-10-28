// #401: a switch to a self-hosted Bee Flow server (the /setup picker or the
// admin settings form) changed only the API target. The embedded app's shell
// kept coming from beeflow.nl: the Cloud frontend against the customer's own
// server, and a request to Bee Flow on every page load. The shell host now
// follows the live server choice, per request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-embed-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = 'https://server.beeflow.nl'; // AppAPI's injected default, not a lock
process.env.BEEFLOW_EMBED_BASE_URL = 'https://beeflow.nl'; // likewise
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const express = require('express');
const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const setupConfig = require('../src/setupConfig');
const setupRouter = require('../src/setup');
const declarativeSettings = require('../src/declarativeSettings');
const { shellBaseUrl } = require('../src/embedTarget');
const { buildEmbedProxy } = require('../src/proxy');

setupConfig.init(storage);
const realFetch = globalThis.fetch;
config.tenantKey = null;
const CLOUD = 'https://server.beeflow.nl';
const SELF = 'http://bee-flow-server.test:3001';

test.after(() => {
    globalThis.fetch = realFetch;
    declarativeSettings.stopPolling();
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

function onCloud() {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'cloud-key', organizationId: 'org-cloud', ncInstanceId: 'inst-1', boundApiBaseUrl: CLOUD,
    }));
    fs.rmSync(path.join(storage, 'pending-bootstrap.json'), { force: true });
    config.apiBaseUrl = CLOUD;
    config.tenantKey = 'cloud-key';
    setupConfig.save({ mode: 'cloud', apiBaseUrl: CLOUD });
}

/** A frontend host that records every path it is asked for. */
async function shellHost() {
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push(req.url);
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>self-hosted shell</title>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

/** GET a shell path through buildEmbedProxy; `baked` answers when it falls through to /public. */
async function getShell(pathname) {
    const embed = buildEmbedProxy();
    const srv = http.createServer((req, res) => {
        req.__shellNext = () => { res.statusCode = 200; res.end('BAKED'); };
        embed(req, res, req.__shellNext);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const res = await realFetch(`http://127.0.0.1:${srv.address().port}${pathname}`);
        return { status: res.status, body: await res.text() };
    } finally {
        srv.close();
    }
}

async function postSetup(body) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const res = await realFetch(`http://127.0.0.1:${server.address().port}/setup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

/** @param {() => boolean} cond */
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** A fake world in which the self-hosted server answers the bootstrap with a fresh key. */
function selfHostedBootstraps(t) {
    const world = installFakeWorld({
        servers: { [SELF]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'self-key', organizationId: 'org-self' }) } },
    });
    t.after(() => world.restore());
    return world;
}

test('on Bee Flow Cloud the shell comes from the Cloud frontend', () => {
    onCloud();
    assert.equal(shellBaseUrl(), 'https://beeflow.nl');
});

test('a /setup switch to self-hosted with a web app URL loads the shell from that host', async (t) => {
    onCloud();
    const host = await shellHost();
    t.after(() => host.srv.close());
    selfHostedBootstraps(t);

    const r = await postSetup({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: host.url });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until(() => config.apiBaseUrl === SELF && config.tenantKey === 'self-key');

    assert.equal(shellBaseUrl(), host.url);
    const shell = await getShell('/index.html');
    assert.equal(shell.status, 200);
    assert.match(shell.body, /self-hosted shell/);
    assert.deepEqual(host.seen, ['/embed/index.html'], 'the shell request reached the chosen web app host');
});

test('self-hosted without a web app URL serves the baked shell, never beeflow.nl', async (t) => {
    onCloud();
    const world = selfHostedBootstraps(t);

    const r = await postSetup({ mode: 'self-hosted', apiBaseUrl: SELF });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until(() => config.apiBaseUrl === SELF && config.tenantKey === 'self-key');

    assert.equal(shellBaseUrl(), null);
    const shell = await getShell('/');
    assert.equal(shell.body, 'BAKED');
    assert.ok(!world.calls.some((c) => c.url.includes('beeflow.nl')), 'no request went to Bee Flow Cloud');
});

test('a failed switch keeps the old server AND its shell host', async (t) => {
    onCloud();
    const world = installFakeWorld({
        servers: { [SELF]: { 'POST /auth/connector/bootstrap': () => json({ error: 'nope' }, 500) } },
    });
    t.after(() => world.restore());

    const r = await postSetup({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: 'http://web.test' });
    assert.equal(r.status, 200);
    await until(() => setupConfig.get()?.mode === 'cloud');
    assert.equal(config.apiBaseUrl, CLOUD);
    assert.equal(setupConfig.get()?.embedBaseUrl, undefined, 'the web app URL went back with the server choice');
    assert.equal(shellBaseUrl(), 'https://beeflow.nl');
});

test('a web app URL is only used while its own server is the live one', () => {
    onCloud();
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: 'http://web.test' });
    // The saved choice names SELF, but the live process still talks to another
    // self-hosted server (a switch in flight, or one that rolled back).
    config.apiBaseUrl = 'http://other.test:3001';
    assert.equal(shellBaseUrl(), null);
    config.apiBaseUrl = SELF;
    assert.equal(shellBaseUrl(), 'http://web.test');
});

test('an invalid web app URL is refused by /setup', async (t) => {
    const world = installFakeWorld();
    t.after(() => world.restore());
    onCloud();
    const r = await postSetup({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: 'http://169.254.169.254' });
    assert.equal(r.status, 400);
    assert.equal(setupConfig.get()?.mode, 'cloud');
});

test('the admin settings form: a web app URL for the live server applies without a re-bootstrap', async (t) => {
    declarativeSettings.stopPolling();
    config.apiBaseUrl = SELF;
    config.tenantKey = 'self-key';
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: SELF });
    const world = installFakeWorld({
        nc: (_method, url) => (url.includes('/ex-app/config/get-values') ? ocs([
            { configkey: 'deployment_mode', configvalue: 'self-hosted' },
            { configkey: 'api_base_url', configvalue: SELF },
            { configkey: 'web_app_url', configvalue: 'http://web.test/' },
        ]) : undefined),
    });
    t.after(() => world.restore());

    await declarativeSettings.applyStoredValuesIfChanged();

    assert.equal(setupConfig.get()?.embedBaseUrl, 'http://web.test');
    assert.equal(shellBaseUrl(), 'http://web.test');
    assert.equal(config.tenantKey, 'self-key');
    assert.ok(!world.calls.some((c) => /\/auth\/connector\/bootstrap/.test(c.url)), 'no re-bootstrap for a shell-only change');
});

test('BEEFLOW_EMBED_BASE_URL naming another host stays the admin lock', () => {
    const before = { locked: config.embedBaseUrlLocked, url: config.embedBaseUrl };
    try {
        config.embedBaseUrlLocked = true;
        config.embedBaseUrl = 'https://frontend.example';
        config.apiBaseUrl = SELF;
        assert.equal(shellBaseUrl(), 'https://frontend.example');
    } finally {
        config.embedBaseUrlLocked = before.locked;
        config.embedBaseUrl = before.url;
    }
});
