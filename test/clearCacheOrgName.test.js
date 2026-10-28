// POST /setup/clear-cache answers with the name of the organisation the
// connector is bound to. It used to read config.organizationName, which nothing
// ever set, so the answer always said `organizationName: null`. The name now
// comes from the bootstrap response (applyTenantKeyResponse) and from the
// tenant-key cache at boot.
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

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test.before(() => {
    globalThis.fetch = async (input, init) => {
        const url = String(input);
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
