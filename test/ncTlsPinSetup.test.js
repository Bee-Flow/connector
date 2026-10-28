// #403, the way out: when Nextcloud's certificate changes, the pin refuses
// every call to Nextcloud, including the user lookup the admin check of
// /setup depends on. The two certificate routes still answer (they are ADMIN
// routes in info.xml, so AppAPI checked the admin), and accepting needs the
// exact key that is waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-nc-pin-setup-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'https://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_NC_TLS_INSECURE = '1'; // the self-signed mode

const OLD = `sha256/${'A'.repeat(43)}=`;
const NEW = `sha256/${'B'.repeat(43)}=`;
const pinFile = path.join(storage, 'nc-trust', 'pins.json');
fs.mkdirSync(path.dirname(pinFile), { recursive: true });
fs.writeFileSync(pinFile, JSON.stringify({
    pins: { 'nc.test:443': { spki: OLD, since: '2026-10-01T00:00:00.000Z' } },
    pending: { 'nc.test:443': { spki: NEW, seenAt: '2026-10-28T09:00:00.000Z' } },
}));

const express = require('express');
const { appApiAuthMiddleware } = require('../src/auth');
const { PIN_MISMATCH } = require('../src/ncTlsPin');
const setupRouter = require('../src/setup');

const realFetch = globalThis.fetch;
test.after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(storage, { recursive: true, force: true });
});

/** Nextcloud behind a certificate the pin refuses: every call fails like fetch does. */
function ncRefusedByPin() {
    globalThis.fetch = async () => {
        const cause = Object.assign(new Error('Nextcloud TLS pin check failed for nc.test:443'), { code: PIN_MISMATCH });
        throw new TypeError('fetch failed', { cause });
    };
}

async function call(method, pathname, body) {
    const app = express();
    app.use(appApiAuthMiddleware);
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const res = await realFetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'AUTHORIZATION-APP-API': Buffer.from('admin:test-secret').toString('base64'),
                'EX-APP-ID': 'bee_flow',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test('with Nextcloud refused, the certificate routes answer and the rest of /setup does not', async () => {
    ncRefusedByPin();
    const state = await call('GET', '/setup/nc-certificate');
    assert.equal(state.status, 200);
    assert.equal(state.body.mode, 'insecure');
    assert.equal(state.body.pending['nc.test:443'].spki, NEW);

    const status = await call('GET', '/setup/status');
    assert.equal(status.status, 502, 'only the certificate routes skip the admin lookup');
});

test('accepting needs the waiting key; then the pin moves to it', async () => {
    ncRefusedByPin();
    assert.equal((await call('POST', '/setup/accept-nc-certificate', {})).status, 400);
    assert.equal((await call('POST', '/setup/accept-nc-certificate', { spki: OLD })).status, 404, 'not the key that is waiting');

    const ok = await call('POST', '/setup/accept-nc-certificate', { spki: NEW });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.accepted, ['nc.test:443']);
    const saved = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    assert.equal(saved.pins['nc.test:443'].spki, NEW);
    assert.deepEqual(saved.pending, {});
});

test('a non-admin with a working Nextcloud is refused by the usual check', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ ocs: { data: { id: 'admin', groups: [] } } }), { status: 200 });
    const res = await call('POST', '/setup/accept-nc-certificate', { spki: NEW });
    assert.equal(res.status, 403);
});
