const log = require('./log');
const { errMessage } = require('./errors');
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

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function _isNetworkError(err) {
    if (!err || typeof err !== 'object') return false;
    // fetch() rejects with TypeError('fetch failed') (+ a cause) when NC is
    // unreachable; AbortSignal.timeout rejects with a TimeoutError/AbortError.
    const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
    const msg = 'message' in err && typeof err.message === 'string' ? err.message : '';
    return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network|timeout/i.test(msg)
        || name === 'TimeoutError' || name === 'AbortError';
}

/**
 * What the warm-up check reads of a fetch Response (also what the tests' stand-ins offer).
 * @typedef {{ status: number, clone(): { text(): Promise<string> } }} ResponseLike
 */

/**
 * The thunk of withWarmupRetry is a fetch, but may be any call: only something with a numeric
 * `status` is a response.
 * @param {unknown} value
 * @returns {value is ResponseLike}
 */
function _looksLikeResponse(value) {
    return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number';
}

/**
 * @param {unknown} res
 * @returns {Promise<boolean>}
 */
async function _isWarmupResponse(res) {
    if (!_looksLikeResponse(res)) return false;
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

/** @param {number} ms */
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @template T
 * @param {() => Promise<T>} fn  thunk performing one fetch (must build a
 *        fresh AbortSignal each call — it is invoked once per attempt).
 * @param {{budgetMs?:number, label?:string, baseDelayMs?:number, maxDelayMs?:number}} [opts]
 * @returns {Promise<T>} the first non-warm-up response (ok or not), or
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
        /** @type {T | null} */
        let res = null;
        /** @type {unknown} */
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
            log.warn(`[AppApiWarmup] ${label}: still warming up after ${budgetMs}ms — giving up`);
            return /** @type {T} */ (res); // hand the last (failed) response back for normal handling
        }

        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const why = netErr ? errMessage(netErr) : `HTTP ${_looksLikeResponse(res) ? res.status : undefined} (AppAPI auth warming up)`;
        log.warn(`[AppApiWarmup] ${label}: ${why} — retrying in ${delay}ms`);
        await _sleep(delay);
    }
}

/**
 * Headers for a service-level call from the connector to Nextcloud's AppAPI: the shared secret with an
 * empty user id (`base64(":" + APP_SECRET)`), which is how every control-plane call here authenticates.
 * @returns {Record<string, string>}
 */
function appApiHeaders() {
    // Read lazily: config throws at import time when APP_SECRET is unset, and the retry helper above
    // has no use for it (its tests run without the app environment).
    const config = require('./config');
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
    };
}

module.exports = { withWarmupRetry, appApiHeaders, _isWarmupResponse, _isNetworkError };
