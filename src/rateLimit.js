/**
 * Rate limiting — the ExApp analogue of `\OCP\Security\RateLimiting\ILimiter`.
 *
 * Nextcloud's developer manual requires an app to "restrict how often someone
 * can execute an operation in a defined time frame", with `registerAnonRequest`
 * / `registerUserRequest` and an HTTP 429 when the budget is spent:
 *   https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/security.html
 *
 * A PHP app injects ILimiter; an ExApp is a separate process with no access to
 * Nextcloud's distributed cache, so the equivalent lives here: fixed windows in
 * memory, bounded, swept lazily.
 *
 * TWO SHAPES, because the traffic has two shapes:
 *
 *   limit()   — bills every request. For endpoints a NC user drives (the setup
 *               actions), keyed by their uid so one user cannot spend another
 *               user's budget.
 *   penalise() — bills only FAILURES. For the machine-to-machine routes
 *               (`/nc/*`, `/hooks/*`), where the caller is Nextcloud itself or
 *               the Bee Flow server and every request lands on one key: billing
 *               successes there would throttle legitimate delivery, while
 *               billing signature failures is exactly the brute-force gate
 *               those routes need.
 *
 * SCOPE, stated plainly: this is per-process and per-replica. A connector is
 * one container per Nextcloud, so that is the whole population — but a limiter
 * here is a brute-force and abuse gate, not a quota system, and it resets on
 * restart.
 */

'use strict';

// Cap on distinct keys held per bucket. Reached only under deliberate churn
// (a caller varying the key); the oldest entries are dropped first, which at
// worst forgives an old offender rather than locking out a new caller.
const MAX_KEYS_PER_BUCKET = 10_000;

const _buckets = new Map(); // name → Map(key → { count, resetAt })

function _bucket(name) {
    let b = _buckets.get(name);
    if (!b) { b = new Map(); _buckets.set(name, b); }
    return b;
}

function _sweep(bucket, now) {
    for (const [key, entry] of bucket) {
        if (entry.resetAt <= now) bucket.delete(key);
        else break; // insertion order ≈ expiry order for a fixed window
    }
    while (bucket.size > MAX_KEYS_PER_BUCKET) {
        bucket.delete(bucket.keys().next().value);
    }
}

/**
 * Consume one unit from `name`/`key`.
 * @returns {{allowed: boolean, remaining: number, retryAfter: number}}
 *          retryAfter is whole seconds, suitable for the header of the same name.
 */
function consume(name, key, { limit, windowMs }) {
    const bucket = _bucket(name);
    const now = Date.now();
    _sweep(bucket, now);

    let entry = bucket.get(String(key));
    if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        bucket.delete(String(key)); // re-insert at the tail so sweeping stays ordered
        bucket.set(String(key), entry);
    }
    entry.count += 1;
    const allowed = entry.count <= limit;
    return {
        allowed,
        remaining: Math.max(0, limit - entry.count),
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
}

/** Read the current state without consuming — used by tests and diagnostics. */
function peek(name, key) {
    const entry = _bucket(name).get(String(key));
    if (!entry || entry.resetAt <= Date.now()) return { count: 0 };
    return { count: entry.count, resetAt: entry.resetAt };
}

/** Forget a key — called when a caller succeeds, so a good request clears the slate. */
function forget(name, key) {
    _bucket(name).delete(String(key));
}

function reset() { _buckets.clear(); }

/**
 * Identify the caller of a browser-driven request.
 *
 * Deliberately NOT the socket address: every request arrives through
 * Nextcloud's AppAPI proxy, so `req.ip` is Nextcloud for all of them and would
 * put every user in one bucket. The Nextcloud uid is the real principal here,
 * and it is established by the AppAPI gate before any of these routes run.
 */
function callerKey(req) {
    return req?.beeflow?.user?.uid || 'anonymous';
}

/**
 * Express middleware that bills every request.
 *
 * Answers 429 with `Retry-After` when the budget is spent, as the manual
 * prescribes for `IRateLimitExceededException`.
 */
function limit(name, { limit: max, windowMs, keyOf = callerKey, message } = {}) {
    return function rateLimitMiddleware(req, res, next) {
        const verdict = consume(name, keyOf(req), { limit: max, windowMs });
        if (verdict.allowed) return next();
        console.warn(`[RateLimit] ${name} exceeded by ${keyOf(req)} — ${max}/${Math.round(windowMs / 1000)}s`);
        res.set('Retry-After', String(verdict.retryAfter));
        return res.status(429).json({
            ok: false,
            code: 'rate_limited',
            error: message || 'Too many attempts. Please wait a moment and try again.',
            retryAfter: verdict.retryAfter,
        });
    };
}

/**
 * Brute-force gate for signature-authenticated routes: call `blocked()` before
 * doing the (cheap) signature check, and `fail()` when it does not verify.
 *
 * Only failures are billed, so a healthy Nextcloud delivering a thousand
 * webhooks is untouched while a thousand forged signatures are not.
 */
function penalise(name, { limit: max, windowMs }) {
    return {
        blocked(key = 'global') {
            const entry = peek(name, key);
            return (entry.count || 0) >= max;
        },
        fail(key = 'global') {
            return consume(name, key, { limit: max, windowMs });
        },
        succeed(key = 'global') {
            forget(name, key);
        },
        windowMs,
    };
}

module.exports = { consume, peek, forget, reset, limit, penalise, callerKey, MAX_KEYS_PER_BUCKET };
