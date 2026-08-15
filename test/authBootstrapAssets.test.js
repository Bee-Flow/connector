/**
 * The bootstrap deadlock: while the connector has no tenant key yet, the auth
 * gate must still serve the SPA bundle.
 *
 * `awaiting_email_verification` is a legitimate in-flight state — the admin is
 * supposed to open the embedded view and type the code that mints the key. The
 * gate served the shell (a document navigation) but answered every asset the
 * shell referenced with `502 {"error":"Tenant key not configured …"}`. So the
 * iframe rendered blank ("Refused to apply style … MIME type application/json"),
 * the SPA never booted, the code was never entered, and the key was never
 * minted — the only path out of the state was gated behind the state itself.
 *
 * SaaS-bound XHR must still fail closed with the 502: without a key there is no
 * JWT to sign it with, and forwarding unauthenticated is what the 502 exists to
 * prevent.
 */
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto'; // no key yet — bootstrap in flight

const test = require('node:test');
const assert = require('node:assert/strict');

const { appApiAuthMiddleware } = require('../src/auth');
const config = require('../src/config');

const OCS_USER = {
    ocs: { data: { id: 'admin', email: 'admin@nc.test', displayname: 'Admin', groups: ['admin'] } },
};

test.before(() => {
    config.tenantKey = null;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => OCS_USER });
});

// Minimal express-shaped req/res. `run` resolves to 'next' when the middleware
// lets the request through, or to the status it terminated with.
function run(path, headers = {}) {
    const req = {
        method: 'GET',
        path,
        url: path,
        headers: {
            'authorization-app-api': Buffer.from('admin:test-secret').toString('base64'),
            ...headers,
        },
    };
    return new Promise(resolve => {
        const res = {
            status(code) { this._code = code; return this; },
            json() { resolve({ outcome: 'terminated', status: this._code }); return this; },
        };
        appApiAuthMiddleware(req, res, () => resolve({ outcome: 'next', req }));
    });
}

const SUBRESOURCE = { 'sec-fetch-mode': 'no-cors', accept: '*/*' };

for (const asset of [
    '/assets/index-3yXM_fvn.js',
    '/assets/index-VQfPtao3.css',
    '/app-icon.svg',
    '/favicon.ico',
]) {
    test(`${asset} is served while bootstrap is in flight`, async () => {
        const { outcome, status } = await run(asset, SUBRESOURCE);
        assert.equal(outcome, 'next', `expected passthrough, got ${status}`);
    });
}

test('the shell navigation itself still passes', async () => {
    const { outcome } = await run('/', { 'sec-fetch-mode': 'navigate', accept: 'text/html' });
    assert.equal(outcome, 'next');
});

test('/setup routes still pass (they drive the verification)', async () => {
    const { outcome, req } = await run('/setup/diagnostics', SUBRESOURCE);
    assert.equal(outcome, 'next');
    assert.equal(req.beeflow.jwt, null, 'no key yet, so no JWT — identity only');
});

test('a SaaS-bound XHR still fails closed with 502 (no JWT to sign it)', async () => {
    const { outcome, status } = await run('/agents/list', { 'sec-fetch-mode': 'cors', accept: '*/*' });
    assert.equal(outcome, 'terminated');
    assert.equal(status, 502);
});

test('once the tenant key lands, assets pass with a real JWT attached', async () => {
    config.tenantKey = 'minted-key';
    try {
        const { outcome, req } = await run('/assets/index-3yXM_fvn.js', SUBRESOURCE);
        assert.equal(outcome, 'next');
        assert.ok(req.beeflow.jwt, 'expected a signed JWT once the key exists');
    } finally {
        config.tenantKey = null;
    }
});
