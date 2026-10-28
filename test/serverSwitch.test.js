// Switching the Bee Flow server from /setup or the admin settings form.
//
//   H3  A failed switch from /setup left config.apiBaseUrl and the saved
//       choice on the new server while the key rolled back to the old one:
//       old-key requests to the new server, and the next restart moved there.
//   M6  A new server that wants the emailed code first was treated as a
//       failure: key and URL rolled back but the pending state stayed, verify
//       went to the OLD server (404), and the settings poll opened a new
//       pending binding on the new server every minute until it answered 429.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OLD = 'http://old.beeflow.test';
const NEW = 'http://new.beeflow.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-switch-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.BEEFLOW_API_BASE_URL = 'https://server.beeflow.nl'; // AppAPI's injected default, not a lock
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const express = require('express');
const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const setupConfig = require('../src/setupConfig');
const setupRouter = require('../src/setup');
const declarativeSettings = require('../src/declarativeSettings');

setupConfig.init(storage);
const realFetch = globalThis.fetch;

async function post(pathname, body) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const res = await realFetch(`http://127.0.0.1:${port}${pathname}`, {
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

function boundToOld() {
    fs.writeFileSync(path.join(storage, 'tenant-key.json'), JSON.stringify({
        tenantKey: 'old-key', organizationId: 'org-old', ncInstanceId: 'inst-1', boundApiBaseUrl: OLD,
    }));
    fs.rmSync(path.join(storage, 'pending-bootstrap.json'), { force: true });
    config.apiBaseUrl = OLD;
    config.tenantKey = 'old-key';
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: OLD });
}

const VERIFY_202 = () => json({
    code: 'email_verification_required', pendingId: 'p1',
    verifyUrl: '/auth/connector/bootstrap/pending/p1/verify',
    resendUrl: '/auth/connector/bootstrap/pending/p1/resend',
    expiresAt: new Date(Date.now() + 600_000).toISOString(), maskedEmail: 'a***@nc.test',
}, 202);

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('H3: a failed switch in /setup leaves the URL, the key and the saved choice on the old server', async () => {
    boundToOld();
    let attempted = false;
    const world = installFakeWorld({
        servers: { [NEW]: { 'POST /auth/connector/bootstrap': () => { attempted = true; return json({ error: 'down' }, 503); } } },
    });
    try {
        const res = await post('/setup', { mode: 'self-hosted', apiBaseUrl: NEW });
        assert.equal(res.status, 200);
        await until(() => attempted && config.tenantKey === 'old-key');
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(config.apiBaseUrl, OLD);
        assert.equal(config.tenantKey, 'old-key');
        assert.equal(setupConfig.get()?.apiBaseUrl, OLD, 'a restart must not move to the server that refused');
    } finally {
        world.restore();
    }
});

test('H3: a successful switch in /setup binds to the new server', async () => {
    boundToOld();
    const world = installFakeWorld({
        servers: { [NEW]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'new-key', organizationId: 'org-new' }) } },
    });
    try {
        await post('/setup', { mode: 'self-hosted', apiBaseUrl: NEW });
        await until(() => config.tenantKey === 'new-key' && fs.existsSync(path.join(storage, 'tenant-key.json')));
        assert.equal(config.apiBaseUrl, NEW);
        assert.equal(setupConfig.get()?.apiBaseUrl, NEW);
        const cached = JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8'));
        assert.equal(cached.boundApiBaseUrl, NEW);
    } finally {
        world.restore();
    }
});

test('M6: a switch to a server that wants the emailed code is pending there, once, and verify goes there', async () => {
    boundToOld();
    let bootstraps = 0;
    let verifiedAt = null;
    const world = installFakeWorld({
        servers: {
            [NEW]: {
                'POST /auth/connector/bootstrap': () => { bootstraps += 1; return VERIFY_202(); },
                'POST /auth/connector/bootstrap/pending/p1/verify': () => { verifiedAt = NEW; return { tenantKey: 'new-key', organizationId: 'org-new' }; },
            },
            [OLD]: {
                'POST /auth/connector/bootstrap/pending/p1/verify': () => { verifiedAt = OLD; return json({ error: 'not found' }, 404); },
            },
        },
        nc: (method, url) => (url.includes('/ex-app/config/get-values')
            ? ocs([{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: NEW }])
            : undefined),
    });
    try {
        for (let i = 0; i < 3; i++) await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(bootstraps, 1, 'one pending binding, not one per poll');
        assert.equal(config.apiBaseUrl, NEW);
        assert.equal(bootstrap.getPendingState()?.status, 'awaiting_email_verification');

        await bootstrap.submitVerificationCode('123456');
        assert.equal(verifiedAt, NEW);
        assert.equal(config.tenantKey, 'new-key');
        assert.equal(config.apiBaseUrl, NEW);
    } finally {
        world.restore();
    }
});

test('M6: a rolled-back switch clears the pending state it created', async () => {
    boundToOld();
    const world = installFakeWorld({
        servers: {
            [NEW]: { 'POST /auth/connector/bootstrap': () => json({ error: 'nope' }, 500) },
        },
    });
    try {
        await assert.rejects(bootstrap.invalidateAndRebootstrap({ apiBaseUrl: NEW }));
        assert.equal(config.apiBaseUrl, OLD);
        assert.equal(config.tenantKey, 'old-key');
        assert.equal(bootstrap.getPendingState(), null, 'heartbeat must not report a verification the working key does not need');
        assert.equal(fs.existsSync(path.join(storage, 'pending-bootstrap.json')), false);
    } finally {
        world.restore();
    }
});
