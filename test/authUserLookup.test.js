// The user lookup behind every browser request: one failed OCS call must not
// turn into a minute of 502s (the embedded app shows its sign-in screen on
// those). A transient failure is retried once, and after that the user the
// last lookup returned stands in for up to a day.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { fetchNextcloudUser, _resetUserCacheForTests } = require('../src/auth');

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

test.beforeEach(() => _resetUserCacheForTests());

test('a transient failure is retried once and the retry answers', async () => {
    const calls = fetchSequence([network, ok]);
    const user = await fetchNextcloudUser('alice');
    assert.equal(user.email, 'a@b');
    assert.equal(calls(), 2);
});

test('after two failures the user from the last successful lookup stands in', async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const calls = fetchSequence([() => http(503)]);
    // Expire the fresh entry: the stale one must be used, not the cache hit.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        const user = await fetchNextcloudUser('alice');
        assert.equal(user.displayName, 'Alice');
        assert.equal(calls(), 2);
    } finally { Date.now = realNow; }
});

test('with nothing to fall back on, two failures still fail', async () => {
    const calls = fetchSequence([network]);
    await assert.rejects(() => fetchNextcloudUser('bob'), /fetch failed/);
    assert.equal(calls(), 2);
});

test("a 4xx is Nextcloud's verdict: no retry, no stale user", async () => {
    fetchSequence([ok]);
    await fetchNextcloudUser('alice');
    const calls = fetchSequence([() => http(404)]);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        await assert.rejects(() => fetchNextcloudUser('alice'), /HTTP 404/);
        assert.equal(calls(), 1);
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
