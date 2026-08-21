// POST /init is in auth.js's LIFECYCLE_PATHS, so it passes the AppAPI gate with
// no header at all — it has to, AppAPI 5.x sends none on the lifecycle calls
// (see lifecycle.test.js). The connector also binds 0.0.0.0 (config.js), so
// "no header needed" means every container on the Nextcloud docker network can
// call it, and each call fans out ~42 authenticated OCS writes into the
// customer's Nextcloud, several behind withWarmupRetry budgets of 20-60s.
// Measured before the guard: 20 headerless requests produced 841 outbound calls
// with 380 in flight at the peak — one packet in, dozens of requests out,
// repeatable without limit.
//
// A hard 401 is not available (it would break install wherever AppAPI omits the
// header), so these pin the two bounds that replace it: a budget for callers
// with no shared secret, and single-flight so runs cannot stack.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
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

const { registerLifecycle, INIT_UNTRUSTED_LIMIT } = require('../src/heartbeat');
const rateLimit = require('../src/rateLimit');

const SIGNED = { 'authorization-app-api': Buffer.from(':test-secret').toString('base64') };

function initRoute() {
    const routes = {};
    registerLifecycle({
        get: (p, h) => { routes[`GET ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
        put: (p, h) => { routes[`PUT ${p}`] = h; },
    });
    return routes['POST /init'];
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

test('unauthenticated /init still answers 200 — AppAPI\'s contract is not negotiable', async () => {
    reset();
    const init = initRoute();
    const bodies = [];
    init({ headers: {}, query: {} }, { json: (b) => bodies.push(b) });
    await settle();
    assert.deepEqual(bodies, [{ status: 'ok' }]);
    assert.ok(outbound > 0, 'and the first call really does register — this is not a blanket refusal');
});

test('a burst of headerless /init calls collapses into one registration run', async () => {
    reset();
    const init = initRoute();
    for (let i = 0; i < 25; i += 1) {
        init({ headers: {}, query: {} }, { json: () => {} });
    }
    await settle();
    assert.equal(completedRuns, 1,
        `25 concurrent calls must coalesce onto the run already in flight, saw ${completedRuns}`);
    assert.ok(peakInFlight < 60,
        `single-flight must cap concurrency against Nextcloud, saw ${peakInFlight} in flight`);
});

test('a caller with no shared secret gets a budget, not an unlimited amplifier', async () => {
    reset();
    const init = initRoute();
    // Sequential and awaited, so single-flight never coalesces them — each one
    // is a fresh run until the budget is spent.
    const CALLS = 12;
    for (let i = 0; i < CALLS; i += 1) {
        init({ headers: {}, query: {} }, { json: () => {} });
        await settle();
    }
    assert.ok(completedRuns > 0,
        'the first calls must still register — an install that omits the header cannot break');
    assert.ok(completedRuns <= INIT_UNTRUSTED_LIMIT,
        `${CALLS} unauthenticated calls drove ${completedRuns} registration runs into Nextcloud; `
        + `the budget is ${INIT_UNTRUSTED_LIMIT}`);
});

test('a caller holding the AppAPI shared secret is never limited', async () => {
    reset();
    const init = initRoute();
    // Spend the untrusted budget first…
    for (let i = 0; i < 8; i += 1) {
        init({ headers: {}, query: {} }, { json: () => {} });
        await settle();
    }
    const spent = completedRuns;
    // …then prove the real AppAPI still gets its work done.
    for (let i = 0; i < 3; i += 1) {
        init({ headers: SIGNED, query: {} }, { json: () => {} });
        await settle();
    }
    assert.equal(completedRuns - spent, 3,
        'the shared secret is what separates AppAPI from a neighbouring container');
});
