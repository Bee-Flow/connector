// Rate limiting — the ExApp stand-in for OCP\Security\RateLimiting\ILimiter
// (developer_manual/digging_deeper/security.html), including the 429 the manual
// asks for when the budget is spent.

const test = require('node:test');
const assert = require('node:assert/strict');

const rateLimit = require('../src/rateLimit');

test.beforeEach(() => rateLimit.reset());

function resStub() {
    return {
        headers: {},
        statusCode: null,
        body: null,
        set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('a budget is spent, then refused with 429 and Retry-After', () => {
    const mw = rateLimit.limit('t', { limit: 3, windowMs: 60_000 });
    const req = { beeflow: { user: { uid: 'alice' } } };
    for (let i = 0; i < 3; i++) {
        const res = resStub();
        let nexted = false;
        mw(req, res, () => { nexted = true; });
        assert.equal(nexted, true, `request ${i + 1} should be inside the budget`);
    }
    const res = resStub();
    mw(req, res, () => assert.fail('the fourth request should have been refused'));
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'rate_limited');
    assert.ok(Number(res.headers['retry-after']) > 0);
});

test('budgets are per Nextcloud user, not shared', () => {
    const mw = rateLimit.limit('t', { limit: 1, windowMs: 60_000 });
    const alice = { beeflow: { user: { uid: 'alice' } } };
    const bob = { beeflow: { user: { uid: 'bob' } } };

    mw(alice, resStub(), () => {});
    mw(alice, resStub(), () => assert.fail('alice is over budget'));

    let bobPassed = false;
    mw(bob, resStub(), () => { bobPassed = true; });
    assert.equal(bobPassed, true, 'alice must not be able to spend bob\'s budget');
});

test('the window expires and the budget comes back', () => {
    const mw = rateLimit.limit('t', { limit: 1, windowMs: 20 });
    const req = { beeflow: { user: { uid: 'alice' } } };
    mw(req, resStub(), () => {});
    mw(req, resStub(), () => assert.fail('still inside the window'));
    return new Promise((resolve) => setTimeout(() => {
        let nexted = false;
        mw(req, resStub(), () => { nexted = true; });
        assert.equal(nexted, true, 'the window has passed; the budget should be back');
        resolve();
    }, 40));
});

// penalise() is what guards /nc/*, /hooks/talk and /hooks/nextcloud: those
// callers are machines on one key, so billing their SUCCESSES would throttle
// real deliveries while billing failures is the brute-force gate they need.
test('penalise bills failures only, and a success clears the slate', () => {
    const gate = rateLimit.penalise('sig', { limit: 3, windowMs: 60_000 });
    assert.equal(gate.blocked(), false);
    gate.fail(); gate.fail();
    assert.equal(gate.blocked(), false, '2 of 3 spent');
    gate.fail();
    assert.equal(gate.blocked(), true, 'budget spent — further attempts refused');
    gate.succeed();
    assert.equal(gate.blocked(), false, 'a valid signature resets the counter');
});

test('key churn cannot grow a bucket without bound', () => {
    const overshoot = rateLimit.MAX_KEYS_PER_BUCKET + 500;
    for (let i = 0; i < overshoot; i++) {
        rateLimit.consume('churn', `key-${i}`, { limit: 1, windowMs: 60_000 });
    }
    // Nothing to assert on size directly (the map is private), so assert the
    // property that matters: an early key was evicted rather than retained.
    assert.equal(rateLimit.peek('churn', 'key-0').count, 0);
    assert.equal(rateLimit.peek('churn', `key-${overshoot - 1}`).count, 1);
});
