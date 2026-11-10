// The user lookup behind every browser request: one failed OCS call must not
// turn into a minute of 502s (the embedded app shows its sign-in screen on
// those). A transient failure is retried once, and after that the user the
// last lookup returned stands in for up to a day. An expired entry is served
// at once and refreshed behind the request; concurrent lookups for one uid
// share a single OCS call (#454).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { fetchNextcloudUser, _resetUserCacheForTests, _settleLookupsForTests } = require('../src/auth');

const OCS_USER = { ocs: { data: { id: 'alice', email: 'a@b', displayname: 'Alice', groups: [] } } };
const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => OCS_USER });
const http = (status) => Promise.resolve({ ok: false, status, json: async () => ({}) });
const network = () => Promise.reject(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));

/** @param {Array<() => Promise<unknown>>} answers one per fetch call, the last one repeats */
function fetchSequence(answers) {
    let calls = 0;
    global.fetch = () => { calls++; return answers[Math.min(calls, answers.length) - 1](); };
    return () => calls;
}

test.beforeEach(async () => { await _settleLookupsForTests(); _resetUserCacheForTests(); });

test('a transient failure is retried once and the retry answers', async () => {
    const calls = fetchSequence([network, ok]);
    const user = await fetchNextcloudUser('alice');
    assert.equal(user.email, 'a@b');
    assert.equal(calls(), 2);
});

test('an expired entry answers at once and is refreshed behind the request; a failed refresh keeps the stale user', async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const calls = fetchSequence([() => http(503)]);
    // Expire the fresh entry: the stale one must be used, not the cache hit.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        const user = await fetchNextcloudUser('alice');
        assert.equal(user.displayName, 'Alice');
        await _settleLookupsForTests();
        assert.equal(calls(), 2, 'the refresh ran once with its retry');
        const again = await fetchNextcloudUser('alice');
        assert.equal(again.displayName, 'Alice', 'still the stale user after the failed refresh');
    } finally { Date.now = realNow; }
});

test('a successful background refresh replaces the stale entry', async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const renamed = { ocs: { data: { ...OCS_USER.ocs.data, displayname: 'Alice B' } } };
    fetchSequence([() => Promise.resolve({ ok: true, status: 200, json: async () => renamed })]);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        assert.equal((await fetchNextcloudUser('alice')).displayName, 'Alice');
        await _settleLookupsForTests();
        assert.equal((await fetchNextcloudUser('alice')).displayName, 'Alice B');
    } finally { Date.now = realNow; }
});

test('concurrent requests for one cold uid share a single lookup', async () => {
    let resolveFetch;
    const gate = new Promise((r) => { resolveFetch = r; });
    const calls = fetchSequence([() => gate.then(() => ({ ok: true, status: 200, json: async () => OCS_USER }))]);
    const pending = Promise.all([1, 2, 3, 4, 5].map(() => fetchNextcloudUser('alice')));
    resolveFetch();
    const users = await pending;
    assert.equal(users.length, 5);
    assert.equal(calls(), 1);
});

test('a 429 or 408 is transient: retried, and the stale user stands in', async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const calls = fetchSequence([() => http(429)]);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        assert.equal((await fetchNextcloudUser('alice')).displayName, 'Alice');
        await _settleLookupsForTests();
        assert.equal(calls(), 2, 'retried once');
        assert.equal((await fetchNextcloudUser('alice')).displayName, 'Alice');
    } finally { Date.now = realNow; }
    await _settleLookupsForTests(); // the refresh the last request started
    _resetUserCacheForTests();
    const cold = fetchSequence([() => http(408), ok]);
    assert.equal((await fetchNextcloudUser('carol')).displayName, 'Alice');
    assert.equal(cold(), 2);
});

test('with nothing to fall back on, two failures still fail', async () => {
    const calls = fetchSequence([network]);
    await assert.rejects(() => fetchNextcloudUser('bob'), /fetch failed/);
    assert.equal(calls(), 2);
});

test("a 4xx is Nextcloud's verdict: no retry, and it drops the stale user for the next request", async () => {
    const cold = fetchSequence([() => http(404)]);
    await assert.rejects(() => fetchNextcloudUser('bob'), /HTTP 404/);
    assert.equal(cold(), 1, 'no retry on a verdict');

    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const calls = fetchSequence([() => http(404)]);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        assert.equal((await fetchNextcloudUser('alice')).displayName, 'Alice', 'served while the refresh runs');
        await _settleLookupsForTests();
        assert.equal(calls(), 1);
        await assert.rejects(() => fetchNextcloudUser('alice'), /HTTP 404/);
    } finally { Date.now = realNow; }
});

test('a stale user older than a day is not used', async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    fetchSequence([network]);
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    try {
        await assert.rejects(() => fetchNextcloudUser('alice'), /fetch failed/);
    } finally { Date.now = realNow; }
});
