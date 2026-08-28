// The /nc/* signature gate must verify FIRST and bill only genuine failures, so
// a flood of forged signatures (this route is PUBLIC) can never lock out the
// legitimate Bee Flow server. Under the old blocked()-before-verify order, 60
// forged requests 429'd every valid one for the rest of the window — a
// renewable, tenant-wide outage of all SaaS→Nextcloud access.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.APP_SECRET = 'test-secret';
// Unreachable upstream: a request that PASSES the gate is proxied and comes back
// 502 (connection refused). That 502 — as opposed to 429 — is the proof it got
// past the rate limiter.
process.env.NEXTCLOUD_URL = 'http://127.0.0.1:1';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const ncProxy = require('../src/ncProxy');
const config = require('../src/config');
const rateLimit = require('../src/rateLimit');

const NC_PATH = '/nc/ocs/v2.php/cloud/user';

function signV2(ts, method, p, ncUid, body) {
    const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
    return crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${method}\n${p}\n${ncUid}\n${bodyHash}`).digest('hex');
}

let server;
let base;

test.before(() => {
    const app = express();
    ncProxy.mount(app);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });
test.beforeEach(() => rateLimit.reset());

const forged = () => `${Math.floor(Date.now() / 1000)}.${'0'.repeat(64)}`;

function get(sig) {
    return fetch(`${base}${NC_PATH}`, { headers: { 'x-beeflow-sig': sig, 'x-beeflow-nc-uid': 'alice' } });
}

test('forged signatures are 401 under budget, then 429 once over it', async () => {
    let last;
    for (let i = 0; i < 61; i++) last = await get(forged());
    assert.equal(last.status, 429, 'the 61st forged signature in the window is refused with 429');
});

test('a valid signature is never locked out by a flood of forged ones', async () => {
    // Trip the limiter with forged signatures first.
    for (let i = 0; i < 61; i++) await get(forged());

    // Now a genuine request: verify passes, so it is forwarded (502, upstream
    // unreachable) rather than 429'd. This is the behaviour the fix restores.
    const ts = Math.floor(Date.now() / 1000);
    const sig = `${ts}.${signV2(ts, 'GET', NC_PATH, 'alice', '')}`;
    const r = await get(sig);
    assert.notEqual(r.status, 429, 'a valid signature must not be collateral to an attacker\'s failures');
    assert.equal(r.status, 502, 'the valid request is forwarded to the (unreachable) upstream');
});
