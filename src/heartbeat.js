/**
 * ExApp lifecycle endpoints.
 *
 * Contract: https://docs.nextcloud.com/server/latest/developer_manual/exapp_development/tech_details/ExAppLifecycle.html
 *
 *   GET  /heartbeat     — unauthenticated, must respond within 10 min of start
 *   POST /init          — authenticated, MUST return HTTP 200 immediately. All
 *                         setup happens in the background; progress is reported
 *                         async via PUT /ocs/v2.php/apps/app_api/ex-app/status.
 *   PUT  /enabled?...   — MUST answer 200; carries no side effect beyond a log
 *                         line. It deliberately does NOT unregister anything:
 *                         AppAPI sends no auth header here either, so wiring
 *                         a teardown onto it would hand every container on the
 *                         docker network a teardown primitive for the
 *                         customer's Nextcloud registrations. Nothing tears down
 *                         on SIGTERM either (shutdown.js); AppAPI cleans up on
 *                         a real uninstall.
 *
 * Why /init returns immediately: AppAPI's `--wait-finish` polls the status
 * field and blocks until init=100 or an error appears. If /init does work
 * synchronously, AppAPI sees the call as "still loading" for the entire
 * duration of that work, and the install command appears to hang.
 */

const config = require('./config');
const { withWarmupRetry, appApiHeaders } = require('./appApiClient');
const { decodeAuthHeader, secretMatches, HDR } = require('./auth');
const { ocsSucceeded } = require('./ocs');
const rateLimit = require('./rateLimit');
const log = require('./log');
const { errMessage } = require('./errors');
const { singleFlight } = require('./singleFlight');
const { TOP_MENU_NAME } = require('./filesActions');

/**
 * Is this caller presenting the AppAPI shared secret?
 *
 * `^/?heartbeat$` is declared PUBLIC in info.xml — it has to be, AppAPI polls it
 * before any user session exists — which means anyone on the internet can GET
 * `<nextcloud>/index.php/apps/app_api/proxy/bee_flow/heartbeat` anonymously.
 * That is fine for liveness and for a coarse bootstrap state, and not fine for
 * the detail attached to a failure: the raw upstream error and the remediation
 * text name the Bee Flow server URL, the operator's egress requirements and the
 * container name, i.e. exactly the internal-network shape
 * developer_manual/prologue/security.html calls out under "Sensitive data
 * exposure". Those fields go only to a caller that holds the secret.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isTrustedLifecycleCaller(req) {
    const decoded = decodeAuthHeader(req.headers?.[HDR.auth]);
    return !!decoded && secretMatches(decoded.secret);
}

/**
 * Budget for a lifecycle call that does NOT present the AppAPI shared secret.
 *
 * `/init` is in auth.js's LIFECYCLE_PATHS, so it passes the AppAPI gate with no
 * header at all — it has to, AppAPI 5.x sends none on the lifecycle calls (see
 * test/lifecycle.test.js). The connector also binds 0.0.0.0 (config.js), so
 * "no header needed" means every container on the Nextcloud docker network can
 * call it, and each call fans out ~42 authenticated OCS writes into the
 * customer's Nextcloud (12 task-processing providers, 19 webhook upserts, the
 * menu/script/settings/Talk/files registrations, status reports), several behind
 * `withWarmupRetry` budgets of 20-60s. Measured before this guard: 20 headerless
 * requests produced 841 outbound calls with 380 in flight at the peak — a
 * one-packet-in, dozens-of-requests-out amplifier against the customer's server.
 *
 * A hard 401 is not available (it would break install on any AppAPI that omits
 * the header), so the trade is: a caller holding the secret is never limited,
 * and a caller without one gets a budget sized for real install/upgrade traffic
 * — AppAPI calls each of these once per install and once per upgrade — and
 * nothing more. Losing the budget cannot brick an install: server.js re-runs the
 * whole registration pipeline on every container boot, and an install or upgrade
 * IS a fresh container.
 *
 * PUT /enabled needs the same bound for a smaller reason. Its only side effect is
 * a `console.log`, but it is reachable with no header at all, so a neighbour on
 * the docker network could emit one log line per request forever — the same
 * unbounded, caller-driven log growth that security.js's unknown-origin log was
 * just fixed for. Bounding it here keeps the two halves of this file consistent:
 * every lifecycle route either holds the secret or spends a budget before the
 * connector does anything on its behalf.
 *
 * Each route bills its own bucket, so flooding one cannot spend another's budget.
 */
const INIT_UNTRUSTED_LIMIT = 3;
const INIT_UNTRUSTED_WINDOW_MS = 15 * 60 * 1000;

/**
 * @param {string} route
 * @param {string} why  completes the sentence in the one log line
 * @returns {boolean}
 */
function untrustedLifecycleAllowed(route, why) {
    const verdict = rateLimit.consume(`lifecycle-${route}`, 'untrusted', {
        limit: INIT_UNTRUSTED_LIMIT,
        windowMs: INIT_UNTRUSTED_WINDOW_MS,
    });
    if (verdict.allowed) return true;
    // One line per window, not one per dropped request — the flood is the point
    // of the attack, and the log must not join in.
    const warn = rateLimit.consume(`lifecycle-${route}-warn`, 'untrusted', {
        limit: 1,
        windowMs: INIT_UNTRUSTED_WINDOW_MS,
    });
    if (warn.allowed) {
        log.warn(`[Lifecycle] ignoring /${route} from a caller with no AppAPI shared secret — `
            + `more than ${INIT_UNTRUSTED_LIMIT} in ${INIT_UNTRUSTED_WINDOW_MS / 60_000} minutes. `
            + `AppAPI calls it on install and upgrade only; a loop of unauthenticated calls is `
            + `someone on this docker network ${why}. `
            + 'Registration still re-runs on every container boot.');
    }
    return false;
}

/** @param {import('express').Express} app */
function registerLifecycle(app) {
    app.get('/heartbeat', (req, res) => {
        // Surface bootstrap state so the NC admin viewing the ExApp page
        // sees an actionable status instead of a silent stuck bootstrap.
        // AppAPI itself only reads `status: ok`; the extra fields are
        // advisory for our own diagnostics (consumed by the SPA error
        // overlay and `app_api:app:heartbeat` operators).
        const trusted = isTrustedLifecycleCaller(req);
        /** @type {ReturnType<typeof import('./bootstrap').getPendingState> | null} */
        let pending = null;
        /** @type {ReturnType<typeof import('./bootstrap').getLastErrorState> | null} */
        let lastError = null;
        /** @type {typeof import('./bootstrap') | null} */
        let bs = null;
        try {
            bs = require('./bootstrap');
            pending = bs.getPendingState?.() || null;
            lastError = bs.getLastErrorState?.() || null;
        } catch (_) { /* tolerate during module init */ }

        if (pending && pending.status === 'awaiting_email_verification') {
            return res.json({
                status: 'ok',
                bootstrap: 'awaiting_email_verification',
                expiresAt: pending.expiresAt,
            });
        }

        if (pending && pending.status === 'pending') {
            return res.json({
                status: 'ok',
                bootstrap: 'awaiting_admin_approval',
                expiresAt: pending.expiresAt,
            });
        }

        // A persisted last-error wins over a bare-OK so the admin sees
        // why bootstrap hasn't completed yet. Cleared on success or on
        // a transition to the pending-approval state above. The state name is
        // public (it answers "is this install stuck?"); the diagnosis is not.
        if (lastError && lastError.status === 'failed' && !config.tenantKey) {
            return res.json({
                status: 'ok', // AppAPI's contract — must be `ok` to keep the ExApp alive
                bootstrap: 'failed',
                ...(trusted ? {
                    category: lastError.category,
                    error: lastError.error,
                    remediation: bs?.remediationFor?.(lastError.category)
                        || 'Bootstrap failed. Check `docker logs nc_app_bee_flow --tail 200` for details.',
                    lastAttemptAt: lastError.lastAttemptAt,
                    nextRetryAt: lastError.nextRetryAt,
                } : {
                    // Where to get the detail, without being the detail.
                    remediation: 'Open Bee Flow in Nextcloud as an administrator, or read '
                        + 'GET /setup/diagnostics, for the cause and how to fix it.',
                }),
            });
        }

        res.json({ status: 'ok' });
    });

    app.post('/init', (req, res) => {
        // Spec compliance: respond fast, run setup in the background. The
        // response is identical whether or not the work runs — AppAPI's contract
        // is a 200, and telling an unauthenticated caller whether they got the
        // connector to act is free reconnaissance.
        res.json({ status: 'ok' });

        if (!isTrustedLifecycleCaller(req)
            && !untrustedLifecycleAllowed('init', 'using the connector to hammer Nextcloud')) return;

        setImmediate(() => {
            runInitInBackground().catch(err => {
                log.error(`[Init] Background setup failed: ${errMessage(err)}`);
                // Surface the error to AppAPI so `--wait-finish` exits cleanly
                // instead of polling forever.
                reportInitProgress(0, errMessage(err)).catch(() => {});
            });
        });
    });

    app.put('/enabled', (req, res) => {
        // Same shape as /init, and for the same reason: `/enabled` is in auth.js's
        // LIFECYCLE_PATHS, so appApiAuthMiddleware returns next() before it parses
        // a single header and the only place a check can live is here. AppAPI's
        // contract is a 200 either way, so the answer never varies — telling an
        // unauthenticated caller whether it got the connector to act is free
        // reconnaissance, and varying it would break `occ app_api:app:enable` on
        // any AppAPI that omits the header.
        res.json({ status: 'ok' });

        if (!isTrustedLifecycleCaller(req)
            && !untrustedLifecycleAllowed('enabled', 'filling the container log')) return;

        log.info(`[Lifecycle] enabled=${req.query?.enabled === '1'}`);
    });
}

// Single-flight. server.js re-runs the pipeline on every boot, AppAPI can call
// /init while that is still going, and the route above is reachable without a
// secret — so overlapping runs are normal rather than exotic. Every OCS call in
// here is idempotent (409 = already registered is accepted), which makes a
// concurrent second run pure cost: before this guard the runs stacked, and 20
// requests put 380 requests in flight against Nextcloud at once. Callers that
// arrive mid-run join the run already in progress and see its outcome.
/** @type {Promise<void> | null} */
let _initInFlight = null;

/** @returns {Promise<void>} */
function runInitInBackground() {
    if (_initInFlight) return _initInFlight;
    _initInFlight = runInitOnce().finally(() => { _initInFlight = null; });
    return _initInFlight;
}

// Background setup pipeline. Each milestone reports progress so that
// AppAPI's deploy state advances visibly during install.
async function runInitOnce() {
    const t0 = Date.now();

    // 1. Auto-bootstrap (only if BEEFLOW_TENANT_KEY=auto and not yet cached)
    if (!config.tenantKey && config.isAutoTenantKey) {
        try {
            const { bootstrapIfNeeded } = require('./bootstrap');
            await bootstrapIfNeeded();
        } catch (err) {
            log.warn(`[Init] Bootstrap retry failed (non-fatal): ${errMessage(err)}`);
        }
    }
    await reportInitProgress(25).catch(() => {});

    // 2. NC UI registrations — independent, run in parallel.
    const declarativeSettings = require('./declarativeSettings');
    await Promise.allSettled([
        registerTopMenu().catch(err => log.warn(`[Init] TopMenu register failed: ${errMessage(err)}`)),
        registerEmbedScript().catch(err => log.warn(`[Init] Embed script register failed: ${errMessage(err)}`)),
        declarativeSettings.registerSettingsForm().catch(err => log.warn(`[Init] Settings form register failed: ${errMessage(err)}`)),
        // Studio-app menu entries (a top-menu icon per published app). A no-op
        // until bootstrap has a tenant key; the poller catches up afterwards.
        require('./studioAppMenus').syncStudioAppMenus()
            .catch(err => log.warn(`[Init] Studio-app menu sync failed: ${errMessage(err)}`)),
    ]);
    declarativeSettings.startPolling();
    await reportInitProgress(60).catch(() => {});

    // 3. Event-listener subscriptions (parallel, with per-call 3s timeout).
    await registerEventListeners();
    await reportInitProgress(100).catch(() => {});

    log.info(`[Init] Background setup completed in ${Date.now() - t0}ms`);
}

async function registerTopMenu() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui/top-menu`;
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({
            name: TOP_MENU_NAME,
            displayName: 'Bee Flow',
            icon: 'img/app.svg',
            adminRequired: 0,
        }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'top-menu', budgetMs: 60_000 });
    // OCS answers HTTP 200 even when it refuses — check ocs.meta.statuscode too,
    // or a rejected registration is logged as "registered" and never retried
    // (the 1.4.0/1.4.1 top-menu bug). 409 = already registered is success.
    const body = await res.text().catch(() => '');
    const { ok, code } = ocsSucceeded(res, body, 'POST');
    if (!ok) {
        throw new Error(`TopMenu register HTTP ${res.status}${code === null ? '' : ` / OCS ${code}`}: ${body.slice(0, 200)}`);
    }
    log.info('[Init] TopMenu entry registered');
}

// Registers a JS file that NC will inject into the embedded template. The
// script renders an iframe that targets NC's signed proxy back to us, so
// the SPA loads inside the Nextcloud chrome.
async function registerEmbedScript() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui/script`;
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({
            type: 'top_menu',
            name: TOP_MENU_NAME,
            path: 'js/embed',
            afterAppId: '',
        }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'embed-script', budgetMs: 60_000 });
    // Same OCS-in-band-refusal check as the top-menu registration above.
    const body = await res.text().catch(() => '');
    const { ok, code } = ocsSucceeded(res, body, 'POST');
    if (!ok) {
        throw new Error(`Script register HTTP ${res.status}${code === null ? '' : ` / OCS ${code}`}: ${body.slice(0, 200)}`);
    }
    log.info('[Init] Embed script registered');
}

// Real-time event subscriptions now go through Nextcloud's bundled
// `webhook_listeners` app — see webhookListeners.js for why (AppAPI's
// `events_listener` API has been removed). This file only wires the lifecycle.
//
// Not every Nextcloud event can be webhooked: `WebhooksEventListener` calls
// `getWebhookSerializable()`, so a class must implement
// `OCP\EventDispatcher\IWebhookCompatibleEvent`. Files, SystemTag, Calendar,
// Forms and Tables events do. User, Group, Share, Deck and Talk events do NOT,
// which is why user/group sync stays on the periodic backstop + manual
// "Sync now", Deck stays on the activity poller, and Talk is handled by the
// Talk-bot webhook rather than an event subscription.
async function registerEventListeners() {
    const { registerTalkBot } = require('./talkBot');
    // Independent of the webhook registration: Talk bots are a different
    // mechanism with a different failure mode (Talk simply not installed).
    await registerTalkBot().catch(err => log.warn(`[Init] Talk bot registration failed: ${errMessage(err)}`));
    await registerTenantKeyDependents();
    log.info('[Init] Real-time user/group sync is not available via webhooks '
        + '(Nextcloud\'s User/Group events are not webhook-compatible); the periodic '
        + 'sync backstop and manual "Sync now" remain in use.');
}

// The registrations that need a tenant key: the Assistant (Task Processing)
// providers, the Files actions and the webhook rows (whose secret derives from
// the key). They run from /init and again every time a key becomes active
// (bootstrap.onTenantKeyReady): a key that arrives after boot (an emailed code
// entered later, a pairing code, a Bee Flow server that was down at boot) used
// to leave Nextcloud with no Bee Flow provider and no Files entries until a
// restart, and a CHANGED key left every webhook row sending the old secret.
// Coalesced: a call during a run for the same key joins it.
const registerTenantKeyDependents = singleFlight(async () => {
    if (!config.tenantKey) return;
    const { ensureWebhookListeners, startRetry } = require('./webhookListeners');
    const { registerTaskProcessing } = require('./taskProcessing');
    const { registerFilesActions } = require('./filesActions');
    await registerTaskProcessing().catch(err => log.warn(`[Init] Task Processing registration failed: ${errMessage(err)}`));
    // AppAPI mounts its Files plugin only if some ExApp has registered a file
    // action, so this call is what puts Bee Flow in the right-click menu at all.
    await registerFilesActions().catch(err => log.warn(`[Init] Files action registration failed: ${errMessage(err)}`));
    const result = await ensureWebhookListeners().catch(err => {
        log.warn(`[Init] Webhook registration failed: ${errMessage(err)}`);
        return { ok: false };
    });
    if (!result.ok) {
        // The admin may not have enabled webhook_listeners yet. Keep trying
        // quietly in the background.
        startRetry();
    }
}, () => config.tenantKey);

require('./bootstrap').onTenantKeyReady(registerTenantKeyDependents);

// Reports init progress to AppAPI. Spec: PUT /ocs/v2.php/apps/app_api/ex-app/status
// with `{progress: 0-100, error?: string}`. AppAPI's `waitInitStepFinish`
// polls the same field every 0.1s; reporting 100 unblocks `--wait-finish`,
// reporting `error` does the same with a failure exit.
/**
 * @param {number} percent
 * @param {string} [errorMessage]
 */
async function reportInitProgress(percent, errorMessage) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/apps/app_api/ex-app/status`;
    const body = errorMessage
        ? { progress: percent, error: errorMessage }
        : { progress: percent };
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'PUT',
        headers: appApiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'init-status', budgetMs: 20_000 });
    if (!res.ok) {
        throw new Error(`Status report failed: HTTP ${res.status}`);
    }
}

module.exports = {
    registerLifecycle,
    runInitInBackground,
    registerTenantKeyDependents,
    registerTopMenu,
    registerEmbedScript,
    INIT_UNTRUSTED_LIMIT,
};
