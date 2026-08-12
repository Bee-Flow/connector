/**
 * ExApp lifecycle endpoints.
 *
 * Contract: https://docs.nextcloud.com/server/latest/developer_manual/exapp_development/tech_details/ExAppLifecycle.html
 *
 *   GET  /heartbeat     — unauthenticated, must respond within 10 min of start
 *   POST /init          — authenticated, MUST return HTTP 200 immediately. All
 *                         setup happens in the background; progress is reported
 *                         async via PUT /ocs/v2.php/apps/app_api/ex-app/status.
 *   PUT  /enabled?...   — authenticated, registers/unregisters NC-side hooks
 *
 * Why /init returns immediately: AppAPI's `--wait-finish` polls the status
 * field and blocks until init=100 or an error appears. If /init does work
 * synchronously, AppAPI sees the call as "still loading" for the entire
 * duration of that work, and the install command appears to hang.
 */

const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

function registerLifecycle(app) {
    app.get('/heartbeat', (req, res) => {
        // Surface bootstrap state so the NC admin viewing the ExApp page
        // sees an actionable status instead of a silent stuck bootstrap.
        // AppAPI itself only reads `status: ok`; the extra fields are
        // advisory for our own diagnostics (consumed by the SPA error
        // overlay and `app_api:app:heartbeat` operators).
        let pending = null;
        let lastError = null;
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
        // a transition to the pending-approval state above.
        if (lastError && lastError.status === 'failed' && !config.tenantKey) {
            return res.json({
                status: 'ok', // AppAPI's contract — must be `ok` to keep the ExApp alive
                bootstrap: 'failed',
                category: lastError.category,
                error: lastError.error,
                remediation: bs?.remediationFor?.(lastError.category)
                    || 'Bootstrap failed. Check `docker logs nc_app_bee_flow --tail 200` for details.',
                lastAttemptAt: lastError.lastAttemptAt,
                nextRetryAt: lastError.nextRetryAt,
            });
        }

        res.json({ status: 'ok' });
    });

    app.post('/init', (req, res) => {
        // Spec compliance: respond fast, run setup in the background.
        res.json({ status: 'ok' });

        setImmediate(() => {
            runInitInBackground().catch(err => {
                console.error(`[Init] Background setup failed: ${err.message}`);
                // Surface the error to AppAPI so `--wait-finish` exits cleanly
                // instead of polling forever.
                reportInitProgress(0, err.message).catch(() => {});
            });
        });
    });

    app.put('/enabled', (req, res) => {
        const enabled = req.query.enabled === '1';
        console.log(`[Lifecycle] enabled=${enabled}`);
        res.json({ status: 'ok' });
    });
}

// Background setup pipeline. Each milestone reports progress so that
// AppAPI's deploy state advances visibly during install.
async function runInitInBackground() {
    const t0 = Date.now();

    // 1. Auto-bootstrap (only if BEEFLOW_TENANT_KEY=auto and not yet cached)
    if (!config.tenantKey && config.isAutoTenantKey) {
        try {
            const { bootstrapIfNeeded } = require('./bootstrap');
            await bootstrapIfNeeded();
        } catch (err) {
            console.warn(`[Init] Bootstrap retry failed (non-fatal): ${err.message}`);
        }
    }
    await reportInitProgress(25).catch(() => {});

    // 2. NC UI registrations — independent, run in parallel.
    const declarativeSettings = require('./declarativeSettings');
    await Promise.allSettled([
        registerTopMenu().catch(err => console.warn(`[Init] TopMenu register failed: ${err.message}`)),
        registerEmbedScript().catch(err => console.warn(`[Init] Embed script register failed: ${err.message}`)),
        declarativeSettings.registerSettingsForm().catch(err => console.warn(`[Init] Settings form register failed: ${err.message}`)),
    ]);
    declarativeSettings.startPolling();
    await reportInitProgress(60).catch(() => {});

    // 3. Event-listener subscriptions (parallel, with per-call 3s timeout).
    await registerEventListeners();
    await reportInitProgress(100).catch(() => {});

    console.log(`[Init] Background setup completed in ${Date.now() - t0}ms`);
}

function appApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
    };
}

async function registerTopMenu() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui/top-menu`;
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({
            name: 'main',
            displayName: 'Bee Flow',
            icon: 'img/app.svg',
            adminRequired: 0,
        }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'top-menu', budgetMs: 60_000 });
    if (!res.ok && res.status !== 409) {
        const body = await res.text().catch(() => '');
        throw new Error(`TopMenu register HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log('[Init] TopMenu entry registered');
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
            name: 'main',
            path: 'js/embed',
            afterAppId: '',
        }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'embed-script', budgetMs: 60_000 });
    if (!res.ok && res.status !== 409) {
        const body = await res.text().catch(() => '');
        throw new Error(`Script register HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log('[Init] Embed script registered');
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
    const { ensureWebhookListeners, startRetry } = require('./webhookListeners');
    const { registerTalkBot } = require('./talkBot');
    const { registerTaskProcessing } = require('./taskProcessing');
    // Independent of the webhook registration: Talk bots are a different
    // mechanism with a different failure mode (Talk simply not installed).
    await registerTalkBot().catch(err => console.warn(`[Init] Talk bot registration failed: ${err.message}`));
    await registerTaskProcessing().catch(err => console.warn(`[Init] Task Processing registration failed: ${err.message}`));
    const result = await ensureWebhookListeners().catch(err => {
        console.warn(`[Init] Webhook registration failed: ${err.message}`);
        return { ok: false };
    });
    if (!result.ok) {
        // Bootstrap may still be in flight, or the admin may not have enabled
        // webhook_listeners yet. Keep trying quietly in the background.
        startRetry();
    }
    console.log('[Init] Real-time user/group sync is not available via webhooks '
        + '(Nextcloud\'s User/Group events are not webhook-compatible); the periodic '
        + 'sync backstop and manual "Sync now" remain in use.');
}

async function unregisterEventListeners() {
    const { unregisterWebhookListeners } = require('./webhookListeners');
    const { unregisterTalkBot } = require('./talkBot');
    const { unregisterTaskProcessing } = require('./taskProcessing');
    await Promise.allSettled([
        unregisterWebhookListeners(),
        unregisterTalkBot(),
        unregisterTaskProcessing(),
    ]);
}

// Reports init progress to AppAPI. Spec: PUT /ocs/v2.php/apps/app_api/ex-app/status
// with `{progress: 0-100, error?: string}`. AppAPI's `waitInitStepFinish`
// polls the same field every 0.1s; reporting 100 unblocks `--wait-finish`,
// reporting `error` does the same with a failure exit.
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

module.exports = { registerLifecycle, unregisterEventListeners, runInitInBackground };
