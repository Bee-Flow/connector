/**
 * AppAPI control-plane warm-up tolerance.
 *
 * On a fresh ExApp install, Nextcloud's AppAPI rejects the connector's
 * shared-secret auth with HTTP 401 / OCS statuscode 997 ("AppAPI
 * authentication failed") for the first few seconds — its ExApp registration
 * (and the secret it shares with us) hasn't propagated yet. During that window
 * every connector→NC control-plane call (admin user lookup, top-menu / embed /
 * settings registration, init-status report) fails. Previously those calls ran
 * exactly once per /init and failed fast, so a fresh install only converged if
 * Nextcloud happened to re-call /init after auth warmed up — luck, not design.
 *
 * withWarmupRetry() wraps a fetch thunk and retries ONLY on that warm-up
 * signature (401/403 + 997 / "AppAPI authentication failed") and on transient
 * network errors (NC not up yet), with capped exponential backoff, until the
 * call succeeds or a budget elapses. Real failures (404/409/500, a genuine
 * 401 without the 997 marker) are returned/raised immediately so callers keep
 * their existing handling and config errors still fail fast.
 *
 * Per-request browser traffic deliberately does NOT use this — those must fail
 * fast (the SPA retries); this is only for install-time provisioning.
 */

const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 4_000;

function _isNetworkError(err) {
    if (!err) return false;
    // fetch() rejects with TypeError('fetch failed') (+ a cause) when NC is
    // unreachable; AbortSignal.timeout rejects with a TimeoutError/AbortError.
    const name = err.name || '';
    const msg = err.message || '';
    return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network|timeout/i.test(msg)
        || name === 'TimeoutError' || name === 'AbortError';
}

async function _isWarmupResponse(res) {
    // AppAPI returns the 997 marker inside the OCS envelope with a 401 (and
    // occasionally a 403) status. Read a clone so the caller still gets the body.
    if (res.status !== 401 && res.status !== 403) return false;
    try {
        const text = await res.clone().text();
        return /\b997\b|AppAPI authentication failed/i.test(text);
    } catch (_) {
        // Body unreadable — treat a bare 401 as warm-up (the only thing that
        // 401s our shared-secret control-plane calls is auth-not-ready).
        return res.status === 401;
    }
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => Promise<Response>} fn  thunk performing one fetch (must build a
 *        fresh AbortSignal each call — it is invoked once per attempt).
 * @param {{budgetMs?:number, label?:string, baseDelayMs?:number, maxDelayMs?:number}} [opts]
 * @returns {Promise<Response>} the first non-warm-up response (ok or not), or
 *          the last warm-up response once the budget is exhausted. Network
 *          errors are retried within budget, then re-thrown.
 */
async function withWarmupRetry(fn, opts = {}) {
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const label = opts.label || 'appapi';
    const deadline = Date.now() + budgetMs;

    for (let attempt = 1; ; attempt++) {
        let res = null;
        let netErr = null;
        try {
            res = await fn();
        } catch (e) {
            if (!_isNetworkError(e)) throw e; // non-transient — surface immediately
            netErr = e;
        }

        if (!netErr && res && !(await _isWarmupResponse(res))) {
            return res; // success OR a non-warm-up failure — caller handles
        }

        if (Date.now() >= deadline) {
            if (netErr) throw netErr;
            console.warn(`[AppApiWarmup] ${label}: still warming up after ${budgetMs}ms — giving up`);
            return res; // hand the last (failed) response back for normal handling
        }

        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const why = netErr ? netErr.message : `HTTP ${res.status} (AppAPI auth warming up)`;
        console.warn(`[AppApiWarmup] ${label}: ${why} — retrying in ${delay}ms`);
        await _sleep(delay);
    }
}

module.exports = { withWarmupRetry, _isWarmupResponse, _isNetworkError };
