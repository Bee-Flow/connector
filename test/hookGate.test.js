// The /hooks/nextcloud secret gate must verify FIRST and bill only genuine
// failures — the same order src/ncProxy.js uses for /nc/*.
//
// This route is PUBLIC and the limiter is GLOBAL-keyed, so under the old
// blocked()-before-verify order a flood of forged hook secrets spent the shared
// budget and then 429'd Nextcloud's real deliveries. The genuine request never
// reached succeed(), so the block stood for the whole window: Nextcloud → Bee
// Flow event delivery — every Deck/Files/Calendar routine trigger on the
// instance — stopped, renewably, for as long as the attacker kept sending.
//
// The sibling case for /nc/* is test/ncProxyGate.test.js. This is the third
// call site of rateLimit.penalise(); the other two were fixed together and this
// one kept the old order.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://127.0.0.1:1';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const rateLimit = require('../src/rateLimit');
const { HOOK_PATH } = require('../src/webhookListeners');

let server;
let base;

test.before(() => {
    const app = express();
    app.use('/', require('../src/automationEventsWebhook'));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });
test.beforeEach(() => rateLimit.reset());

/** The real derivation (webhookListeners.hookSecret) — not the tenant key. */
const realSecret = () => crypto.createHmac('sha256', config.tenantKey)
    .update('beeflow:webhook-listener:v1').digest('hex');

function post(secret) {
    return fetch(`${base}${HOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beeflow-hook-secret': secret },
        body: JSON.stringify({ event: { class: 'OCA\\DAV\\Events\\CalendarObjectCreatedEvent' } }),
    });
}

test('forged hook secrets are 401 under budget, then 429 once over it', async () => {
    let last;
    for (let i = 0; i < 61; i++) last = await post('not-the-secret');
    assert.equal(last.status, 429, 'the 61st forged secret in the window is refused with 429');
});

test('the real hook secret is never locked out by a flood of forged ones', async () => {
    // Spend the whole global budget with forgeries first.
    for (let i = 0; i < 61; i++) await post('not-the-secret');

    // A genuine delivery must still be accepted. Under the old order this was
    // a 429 and stayed one for the rest of the window.
    const r = await post(realSecret());
    assert.notEqual(r.status, 429, 'a valid hook secret must not be collateral to an attacker\'s failures');
    assert.ok(r.status < 500, `genuine delivery rejected with ${r.status}`);
});

test('a success clears the budget the forgeries consumed', async () => {
    for (let i = 0; i < 30; i++) await post('not-the-secret');
    await post(realSecret());               // succeed() forgets the counter
    const r = await post('not-the-secret'); // back under budget → 401, not 429
    assert.equal(r.status, 401, 'the counter should have been reset by the valid delivery');
});
