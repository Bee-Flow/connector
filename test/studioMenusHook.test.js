/**
 * The SaaS push hook (`POST /hooks/studio-menus`, src/studioAppMenus.js).
 *
 * Pins the cross-repo contract with server/appStudio/nextcloudMenuSync.js:
 *   - the signature is the /nc/* v2 form — HMAC(tenantKey,
 *     `${ts}\nPOST\n/hooks/studio-menus\n\n${sha256(body)}`), empty uid;
 *   - a valid push runs the reconcile synchronously and answers its counts,
 *     so the SaaS can tell the owner "reload Nextcloud" only when true;
 *   - forgeries are 401 under budget and 429 over it, and a flood of them can
 *     never lock the genuine SaaS out (verify first, bill only failures —
 *     the same order test/hookGate.test.js pins for /hooks/nextcloud).
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nextcloud.invalid';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-menus-hook-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const config = require('../src/config');
const rateLimit = require('../src/rateLimit');
const menus = require('../src/studioAppMenus');

const realFetch = global.fetch;
let server;
let base;

test.before(() => {
    config.ncInstanceId = 'nc-instance-a';
    const app = express();
    menus.mountPushHook(app);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); global.fetch = realFetch; });
test.beforeEach(() => rateLimit.reset());

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Exactly what the SaaS signer emits (server/integrations/ncSigning.js). */
function sign(body, { key = 'tenant-key', ts = Math.floor(Date.now() / 1000) } = {}) {
    const message = `${ts}\nPOST\n${menus.PUSH_HOOK_PATH}\n\n${sha256(body)}`;
    return `${ts}.${crypto.createHmac('sha256', key).update(message).digest('hex')}`;
}

function push(body, sig) {
    return realFetch(`${base}${menus.PUSH_HOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beeflow-sig': sig, 'x-beeflow-nc-uid': '' },
        body,
    });
}

const okJson = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
});

/** Mock the connector's OUTBOUND fetches (SaaS list + AppAPI OCS). */
function mockOutbound(apps) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        calls.push({ url: u, method: opts.method || 'GET' });
        if (u.includes('/api/nextcloud/studio-apps')) return okJson({ apps });
        if (u.includes('/ocs/')) return okJson({ ocs: { meta: { statuscode: 100 } } });
        throw new Error(`unexpected fetch: ${u}`);
    };
    return calls;
}

const UUID = '4c6cbdcf-6a7e-4d9b-9f6e-2f1f5c1d0a01';

test('a correctly signed push reconciles right away and answers the counts', async () => {
    const calls = mockOutbound([{ id: UUID, name: 'Quote intake', icon: 'Scissors' }]);
    const body = JSON.stringify({ reason: 'nextcloud_menu', studioAppId: UUID, sentAt: new Date().toISOString() });

    const res = await push(body, sign(body));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.added, 1, 'the entry was registered before we answered');
    assert.ok(calls.some(c => c.url.includes('/api/nextcloud/studio-apps')), 'fetched the list from the SaaS');
    assert.ok(calls.some(c => c.url.includes('/ui/top-menu') && c.method === 'POST'), 'registered with AppAPI');

    // Clean up the registration for the tests below.
    mockOutbound([]);
    const gone = await (await push(body, sign(body))).json();
    assert.equal(gone.removed, 1);
});

test('a reconcile that fails is still HTTP 200 with ok:false — never a 5xx for HaRP to count', async () => {
    global.fetch = async (url) => {
        if (String(url).includes('/api/nextcloud/studio-apps')) return okJson({ error: 'boom' }, 500);
        throw new Error(`unexpected fetch: ${url}`);
    };
    const body = JSON.stringify({ reason: 'publish', studioAppId: UUID });
    const res = await push(body, sign(body));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.ok, false);
    assert.match(out.error, /HTTP 500/);
});

test('wrong key, stale timestamp, or a tampered body → 401, and the SaaS is never contacted', async () => {
    const calls = mockOutbound([]);
    const body = JSON.stringify({ reason: 'nextcloud_menu', studioAppId: UUID });

    assert.equal((await push(body, sign(body, { key: 'not-the-key' }))).status, 401);
    assert.equal((await push(body, sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
    assert.equal((await push(body.replace('nextcloud_menu', 'tampered'), sign(body))).status, 401);
    assert.equal((await push(body, 'garbage')).status, 401);
    assert.equal((await realFetch(`${base}${menus.PUSH_HOOK_PATH}`, { method: 'POST', body })).status, 401);

    assert.equal(calls.length, 0, 'no outbound call happens for an unauthenticated push');
});

test('forged signatures are 401 under budget, then 429 — and the genuine SaaS is never locked out', async () => {
    mockOutbound([]);
    const body = JSON.stringify({ reason: 'nextcloud_menu', studioAppId: UUID });

    let last;
    for (let i = 0; i < 61; i++) last = await push(body, sign(body, { key: 'forged' }));
    assert.equal(last.status, 429, 'the 61st forgery in the window is refused with 429');
    assert.ok(last.headers.get('retry-after'));

    // The real caller still gets through: verify-then-bill means a flood of
    // forgeries never spends the budget a valid signature is checked against.
    const genuine = await push(body, sign(body));
    assert.equal(genuine.status, 200);
});
