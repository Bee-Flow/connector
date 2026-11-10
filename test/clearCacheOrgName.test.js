// POST /setup/clear-cache answers with the name of the organisation the
// connector is bound to. The name comes from the bootstrap response
// (applyTenantKeyResponse) and from the tenant-key cache at boot.
//
// Without a chosen server there is nothing to clear (409), and an install
// with an install-time tenant key keeps that key without a bootstrap request.
//
// The route runs for real (express, setup router, bootstrap); only the network
// is replaced: a fetch stub answers the Nextcloud OCS calls and the Bee Flow
// bootstrap endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-orgname-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.APP_PERSISTENT_STORAGE = storage;

const express = require('express');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const setupRouter = require('../src/setup');
const taskProcessing = require('../src/taskProcessing');

const realFetch = globalThis.fetch;
const saas = { organizationId: 'org-2', organizationName: 'Second Org' };
/** Every outbound call the connector made, as `METHOD url`. */
const outbound = [];

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test.before(() => {
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        outbound.push(`${init?.method || 'GET'} ${url}`);
        if (url.startsWith('http://beeflow.test/')) {
            if (url.endsWith('/auth/connector/bootstrap') && init?.method === 'POST') {
                return json({ tenantKey: 'tk-new', ...saas });
            }
            return realFetch(input, init);
        }
        if (url.includes('/cloud/capabilities')) {
            return json({ ocs: { data: { version: { string: '31.0.0' }, capabilities: { theming: { name: 'NC', instanceid: 'inst-1' } } } } });
        }
        if (url.includes('/cloud/groups/admin/users')) return json({ ocs: { data: { users: ['admin'] } } });
        if (url.includes('/cloud/users/admin')) {
            return json({ ocs: { data: { id: 'admin', email: 'admin@nc.test', displayname: 'Admin', groups: ['admin'] } } });
        }
        return json({}, 404);
    };
});

test.after(() => {
    globalThis.fetch = realFetch;
    taskProcessing.stopPolling();
    fs.rmSync(storage, { recursive: true, force: true });
});

async function post(pathname, isNcAdmin = true) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        const res = await realFetch(`http://127.0.0.1:${port}${pathname}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test('a cached binding loads the organisation name at boot', async () => {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'tk-old', organizationId: 'org-1', organizationName: 'First Org', ncInstanceId: 'inst-1',
    }));
    await bootstrap.bootstrapIfNeeded();
    assert.equal(config.tenantKey, 'tk-old');
    assert.equal(config.organizationName, 'First Org');
});

test('clear-cache re-binds and answers with the name of the new organisation', async () => {
    const { status, body } = await post('/setup/clear-cache');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.organizationId, 'org-2');
    assert.equal(body.organizationName, 'Second Org');
    // The cache written for the next boot carries the same name.
    const cached = JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8'));
    assert.equal(cached.organizationName, 'Second Org');
});

test('a failed re-bind rolls the organisation name back with the key', async () => {
    const before = { tenantKey: config.tenantKey, organizationName: config.organizationName };
    const okFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/auth/connector/bootstrap')) return json({ error: 'nope' }, 500);
        return okFetch(input, init);
    };
    try {
        const { status } = await post('/setup/clear-cache');
        assert.notEqual(status, 200);
    } finally {
        globalThis.fetch = okFetch;
    }
    assert.equal(config.tenantKey, before.tenantKey);
    assert.equal(config.organizationName, before.organizationName);
});

test('no Bee Flow server chosen: 409, and the binding on disk is left alone', async () => {
    const before = { apiBaseUrl: config.apiBaseUrl, tenantKey: config.tenantKey };
    const cacheFile = path.join(storage, 'tenant-key.json');
    const cacheBefore = fs.readFileSync(cacheFile, 'utf8');
    config.apiBaseUrl = null;
    config.tenantKey = null; // no server means no key in memory
    outbound.length = 0;
    try {
        const { status, body } = await post('/setup/clear-cache');
        assert.equal(status, 409);
        assert.equal(body.ok, false);
        assert.equal(body.code, 'server_not_chosen');
        assert.deepEqual(outbound, [], 'nothing is asked anywhere');
        assert.equal(fs.readFileSync(cacheFile, 'utf8'), cacheBefore);
    } finally {
        config.apiBaseUrl = before.apiBaseUrl;
        config.tenantKey = before.tenantKey;
    }
});

test('with an install-time tenant key, clear-cache keeps that key and makes no bootstrap request', async () => {
    const before = { tenantKey: config.tenantKey, organizationId: config.organizationId, organizationName: config.organizationName };
    const cacheFile = path.join(storage, 'tenant-key.json');
    const cacheBefore = fs.readFileSync(cacheFile, 'utf8');
    fs.rmSync(cacheFile); // an install-time key has no cache file
    config.isAutoTenantKey = false;
    config.envTenantKey = 'pasted-key';
    config.tenantKey = 'pasted-key';
    outbound.length = 0;
    try {
        const { status, body } = await post('/setup/clear-cache');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.verificationPending, false);
        assert.equal(config.tenantKey, 'pasted-key');
        assert.deepEqual(outbound.filter((c) => c.includes('/auth/connector/bootstrap')), []);
        assert.deepEqual(outbound.filter((c) => c.includes('/cloud/groups/admin/users')), [], 'the administrators are not read');
        assert.equal(fs.existsSync(cacheFile), false, 'an install-time key is not cached');
    } finally {
        config.isAutoTenantKey = true;
        config.envTenantKey = null;
        Object.assign(config, before);
        fs.writeFileSync(cacheFile, cacheBefore);
    }
});
