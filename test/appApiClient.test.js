// withWarmupRetry tolerates the AppAPI auth warm-up window (401/997) on a fresh
// install but must NOT retry real failures and must fast-fail config errors.

const test = require('node:test');
const assert = require('node:assert/strict');

const { withWarmupRetry, _isNetworkError } = require('../src/appApiClient');

// Minimal stand-in for a fetch Response. clone() must return an independent
// readable copy (withWarmupRetry reads a clone to classify warm-up).
function fakeRes(status, body = '') {
    return {
        status,
        ok: status >= 200 && status < 300,
        clone() { return fakeRes(status, body); },
        async text() { return body; },
    };
}

const WARMUP_BODY = JSON.stringify({ ocs: { meta: { statuscode: 997, message: 'AppAPI authentication failed' } } });

test('retries 401/997 warm-up then returns the eventual 200', async () => {
    let calls = 0;
    const res = await withWarmupRetry(() => {
        calls++;
        return Promise.resolve(calls < 3 ? fakeRes(401, WARMUP_BODY) : fakeRes(200, 'ok'));
    }, { label: 'test', baseDelayMs: 1, maxDelayMs: 2, budgetMs: 5_000 });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
});

test('does NOT retry a non-warm-up failure (404) — returns immediately', async () => {
    let calls = 0;
    const res = await withWarmupRetry(() => { calls++; return Promise.resolve(fakeRes(404, 'nope')); },
        { label: 'test', baseDelayMs: 1, budgetMs: 5_000 });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
});

test('does NOT retry a bare 401 without the 997 marker', async () => {
    let calls = 0;
    const res = await withWarmupRetry(() => { calls++; return Promise.resolve(fakeRes(401, 'Unauthorized')); },
        { label: 'test', baseDelayMs: 1, budgetMs: 5_000 });
    assert.equal(res.status, 401);
    assert.equal(calls, 1);
});

test('409 (already registered) is not warm-up — returned at once', async () => {
    let calls = 0;
    const res = await withWarmupRetry(() => { calls++; return Promise.resolve(fakeRes(409)); },
        { baseDelayMs: 1, budgetMs: 5_000 });
    assert.equal(res.status, 409);
    assert.equal(calls, 1);
});

test('rethrows a non-network (config) error immediately', async () => {
    let calls = 0;
    await assert.rejects(
        () => withWarmupRetry(() => { calls++; throw new Error('boom config'); }, { baseDelayMs: 1, budgetMs: 5_000 }),
        /boom config/,
    );
    assert.equal(calls, 1);
});

test('retries transient network errors, then rethrows once budget elapses', async () => {
    let calls = 0;
    await assert.rejects(
        () => withWarmupRetry(() => { calls++; const e = new Error('fetch failed'); throw e; },
            { baseDelayMs: 1, maxDelayMs: 2, budgetMs: 30 }),
        /fetch failed/,
    );
    assert.ok(calls >= 2, `expected multiple attempts, got ${calls}`);
});

test('returns the last warm-up response once budget exhausted', async () => {
    let calls = 0;
    const res = await withWarmupRetry(() => { calls++; return Promise.resolve(fakeRes(401, WARMUP_BODY)); },
        { baseDelayMs: 1, maxDelayMs: 2, budgetMs: 30 });
    assert.equal(res.status, 401);
    assert.ok(calls >= 2);
});

test('_isNetworkError classifies timeout/abort and fetch-failed', () => {
    assert.equal(_isNetworkError({ name: 'TimeoutError', message: 'The operation was aborted' }), true);
    assert.equal(_isNetworkError(new Error('fetch failed')), true);
    assert.equal(_isNetworkError(new Error('ECONNREFUSED 1.2.3.4:443')), true);
    assert.equal(_isNetworkError(new Error('totally unrelated')), false);
});
