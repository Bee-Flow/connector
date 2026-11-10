// POST /init fans out about 42 authenticated OCS writes into the customer's
// Nextcloud, several behind withWarmupRetry budgets of 20-60s, and the connector
// binds 0.0.0.0 (config.js) on a docker network it shares with other containers.
// Measured while the route was still open to headerless callers: 20 requests
// produced 841 outbound calls with 380 in flight at the peak.
//
// AppAPI signs /init and /enabled with the shared secret (stable32..stable35,
// see auth.js), so a caller without it is refused outright and does nothing.
// These pin that, plus single-flight so signed runs cannot stack either.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key'; // installed system: bootstrap is a no-op

// Stand in for the customer's Nextcloud. Counting what reaches it IS the
// measurement — the amplification is outbound, not inbound.
let outbound = 0;
let inFlight = 0;
let peakInFlight = 0;
let completedRuns = 0;
global.fetch = async (url, opts = {}) => {
    outbound += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // The pipeline's last act is reporting progress 100, so this counts runs.
    if (String(url).endsWith('/ex-app/status') && String(opts.body || '').includes('"progress":100')) {
        completedRuns += 1;
    }
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return {
        ok: true,
        status: 200,
        clone: () => ({ text: async () => '{}' }),
        text: async () => '{}',
        json: async () => ({ ocs: { data: [] } }),
    };
};

const { registerLifecycle } = require('../src/heartbeat');
const rateLimit = require('../src/rateLimit');

const SIGNED = { 'authorization-app-api': Buffer.from(':test-secret').toString('base64') };

function lifecycleRoutes() {
    const routes = {};
    registerLifecycle({
        get: (p, h) => { routes[`GET ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
        put: (p, h) => { routes[`PUT ${p}`] = h; },
    });
    return routes;
}

function initRoute() {
    return lifecycleRoutes()['POST /init'];
}

/** A response double that records what the route answered. */
function recorder() {
    const seen = { status: 200, bodies: [] };
    const res = {
        status: (code) => { seen.status = code; return res; },
        json: (b) => { seen.bodies.push(b); return res; },
    };
    return { res, seen };
}

function reset() {
    rateLimit.reset();
    outbound = 0;
    peakInFlight = 0;
    completedRuns = 0;
}

/** Wait until the background pipeline stops making calls. */
async function settle() {
    let last = -1;
    while (last !== outbound) {
        last = outbound;
        await new Promise((r) => setTimeout(r, 80));
    }
}

test('a headerless /init is refused and reaches Nextcloud with nothing', async () => {
    reset();
    const init = initRoute();
    const { res, seen } = recorder();
    init({ headers: {}, query: {} }, res);
    await settle();
    assert.equal(seen.status, 401);
    assert.equal(outbound, 0, `an unauthenticated /init drove ${outbound} calls into Nextcloud`);
});

test('an /init with the wrong secret is refused the same way', async () => {
    reset();
    const init = initRoute();
    const { res, seen } = recorder();
    const wrong = { 'authorization-app-api': Buffer.from(':not-the-secret').toString('base64') };
    init({ headers: wrong, query: {} }, res);
    await settle();
    assert.equal(seen.status, 401);
    assert.equal(outbound, 0);
});

test('a flood of headerless /init calls stays at zero outbound calls', async () => {
    reset();
    const init = initRoute();
    for (let i = 0; i < 25; i += 1) {
        init({ headers: {}, query: {} }, recorder().res);
    }
    await settle();
    assert.equal(outbound, 0);
    assert.equal(completedRuns, 0);
});

test('a signed /init answers 200 at once and registers', async () => {
    reset();
    const init = initRoute();
    const { res, seen } = recorder();
    init({ headers: SIGNED, query: {} }, res);
    assert.deepEqual(seen.bodies, [{ status: 'ok' }], 'the answer must not wait for the registration run');
    await settle();
    assert.equal(seen.status, 200);
    assert.equal(completedRuns, 1);
});

test('a burst of signed /init calls collapses into one registration run', async () => {
    reset();
    const init = initRoute();
    for (let i = 0; i < 25; i += 1) {
        init({ headers: SIGNED, query: {} }, recorder().res);
    }
    await settle();
    assert.equal(completedRuns, 1,
        `25 concurrent calls must coalesce onto the run already in flight, saw ${completedRuns}`);
    assert.ok(peakInFlight < 60,
        `single-flight must cap concurrency against Nextcloud, saw ${peakInFlight} in flight`);
});

test('a caller holding the AppAPI shared secret is never limited', async () => {
    reset();
    const init = initRoute();
    for (let i = 0; i < 8; i += 1) {
        init({ headers: {}, query: {} }, recorder().res);
    }
    await settle();
    for (let i = 0; i < 3; i += 1) {
        init({ headers: SIGNED, query: {} }, recorder().res);
        await settle();
    }
    assert.equal(completedRuns, 3,
        'refusing unsigned callers must not spend anything a signed caller needs');
});

test('PUT /enabled: refused without the secret, 200 with no `error` key with it', () => {
    reset();
    const enabled = lifecycleRoutes()['PUT /enabled'];
    const anon = recorder();
    enabled({ headers: {}, query: { enabled: '0' } }, anon.res);
    assert.equal(anon.seen.status, 401);

    // AppAPI fails the enable/disable when the body carries a non-empty `error`.
    const signed = recorder();
    enabled({ headers: SIGNED, query: { enabled: '1' } }, signed.res);
    assert.equal(signed.seen.status, 200);
    assert.deepEqual(signed.seen.bodies, [{ status: 'ok' }]);
});
