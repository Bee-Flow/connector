// "Rotate tenant key" (/setup) must really replace the key. It used to
// re-bootstrap, which got the SAME key back from the server, and the page then
// showed that unchanged fingerprint as the "new" one: a suspected-leaked key
// stayed valid while the admin believed it was revoked.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const SAAS = 'http://beeflow.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-rotate-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = SAAS;
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const express = require('express');
const { installFakeWorld, json } = require('./support/fakeWorld');
const config = require('../src/config');
require('../src/heartbeat'); // key-dependent registrations follow a new key
const setupRouter = require('../src/setup');

const realFetch = globalThis.fetch;
const fp = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
const secretFor = (key) => crypto.createHmac('sha256', key).update('beeflow:webhook-listener:v1').digest('hex');

async function pressRotate() {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const res = await realFetch(`http://127.0.0.1:${port}/setup/rotate-tenant-key`, { method: 'POST' });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
        await new Promise((r) => setTimeout(r, 10));
    }
}

function bound(key = 'old-key') {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: key, organizationId: 'org-1', organizationName: 'Org', ncInstanceId: 'inst-1', boundApiBaseUrl: SAAS,
    }));
    config.tenantKey = key;
    config.organizationId = 'org-1';
    config.ncInstanceId = 'inst-1';
}

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('rotation asks the server for a new key, signed with the current one, and applies it', async () => {
    bound();
    let seenAuth = null;
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                'POST /auth/connector/rotate-key': (init) => {
                    seenAuth = init.headers.Authorization;
                    return { tenantKey: 'new-key', organizationId: 'org-1' };
                },
            },
        },
    });
    try {
        const { status, body } = await pressRotate();
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.previousTenantKeyFingerprint, fp('old-key'));
        assert.equal(body.tenantKeyFingerprint, fp('new-key'));
        assert.equal(config.tenantKey, 'new-key');

        const claims = jwt.verify(seenAuth.replace(/^Bearer /, ''), 'old-key', { audience: 'beeflow.nl', issuer: 'nextcloud-connector' });
        assert.equal(claims.purpose, 'connector:rotate-tenant-key');
        assert.ok(claims.exp - claims.iat <= 120);

        const cached = JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8'));
        assert.equal(cached.tenantKey, 'new-key');
        assert.equal(cached.organizationId, 'org-1');
        // Nextcloud's webhook rows move to the secret of the new key.
        await until(() => world.calls.some((c) => c.method === 'POST' && c.url.includes('/webhook_listeners/')));
        const secrets = world.calls.filter((c) => c.method === 'POST' && c.url.includes('/webhook_listeners/'))
            .map((c) => JSON.parse(c.body).authData['X-Beeflow-Hook-Secret']);
        assert.ok(secrets.every((s) => s === secretFor('new-key')));
    } finally {
        world.restore();
    }
});

test('the same key back is reported as a failure, never as "rotated"', async () => {
    bound();
    const world = installFakeWorld({ servers: { [SAAS]: { 'POST /auth/connector/rotate-key': () => ({ tenantKey: 'old-key' }) } } });
    try {
        const { status, body } = await pressRotate();
        assert.notEqual(status, 200);
        assert.equal(body.ok, false);
        assert.equal(config.tenantKey, 'old-key');
    } finally {
        world.restore();
    }
});

test('a server without the rotation endpoint says so and keeps the key', async () => {
    bound();
    const world = installFakeWorld({ servers: { [SAAS]: {} } }); // every path 404s
    try {
        const { body } = await pressRotate();
        assert.equal(body.ok, false);
        assert.match(body.error, /cannot rotate/);
        assert.equal(config.tenantKey, 'old-key');
    } finally {
        world.restore();
    }
});

test('a lost answer re-fetches the binding, so the connector never keeps a key the server dropped', async () => {
    bound();
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                // The server rotated, but the answer never arrived.
                'POST /auth/connector/rotate-key': () => { throw new TypeError('fetch failed'); },
                'POST /auth/connector/bootstrap': () => ({ tenantKey: 'rotated-key', organizationId: 'org-1' }),
            },
        },
    });
    try {
        const { body } = await pressRotate();
        assert.equal(body.ok, true);
        assert.equal(config.tenantKey, 'rotated-key');
        assert.equal(body.tenantKeyFingerprint, fp('rotated-key'));
    } finally {
        world.restore();
    }
});

test('a lost answer when nothing rotated keeps the key and says so', async () => {
    bound();
    const world = installFakeWorld({
        servers: {
            [SAAS]: {
                'POST /auth/connector/rotate-key': () => json({ error: 'boom' }, 502),
                'POST /auth/connector/bootstrap': () => ({ tenantKey: 'old-key', organizationId: 'org-1' }),
            },
        },
    });
    try {
        const { body } = await pressRotate();
        assert.equal(body.ok, false);
        assert.equal(config.tenantKey, 'old-key');
    } finally {
        world.restore();
    }
});
