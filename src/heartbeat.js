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
    const res = await fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({
            name: 'main',
            displayName: 'Bee Flow',
            icon: 'img/app.svg',
            adminRequired: 0,
        }),
        signal: AbortSignal.timeout(5_000),
    });
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
    const res = await fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({
            type: 'top_menu',
            name: 'main',
            path: 'js/embed',
            afterAppId: '',
        }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok && res.status !== 409) {
        const body = await res.text().catch(() => '');
        throw new Error(`Script register HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log('[Init] Embed script registered');
}

// Canonical list of events the connector subscribes to.
//
// Two families:
//   1. User/group sync (actionHandler webhook/nc-events → eventsWebhook.js →
//      ncUserGroupSync). Index 0 MUST stay a user/group event — it's used as
//      the capability probe by registerEventListeners().
//   2. Automation event-bridge (actionHandler webhook/automation →
//      automationEventsWebhook.js → SaaS POST /api/automation/events/nextcloud,
//      which IS now live — server/routes/automation.js). Without these, no
//      push-based NC trigger (share/calendar/deck/talk, file mutations) can
//      fire; only the activity-feed pollers work.
//
// Class names are best-effort across NC/app versions. registerEventListeners()
// fans out with per-event error tolerance, so a class an installed NC doesn't
// recognise is skipped (counted as failed) without affecting the rest.
// VERIFY the Deck/Talk class names on the target NC/app versions before
// relying on push for those — see NC-ROUTINES-REMEDIATION-PLAN.md (WS-3).
const SUBSCRIBED_EVENTS = [
    { eventType: 'OCP\\User\\Events\\UserCreatedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\User\\Events\\UserDeletedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\User\\Events\\UserChangedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\Group\\Events\\UserAddedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\Group\\Events\\UserRemovedEvent', actionHandler: 'webhook/nc-events' },
    // ── Automation event-bridge → webhook/automation ──
    // Files
    { eventType: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeWrittenEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeDeletedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeRenamedEvent', actionHandler: 'webhook/automation' },
    // Shares
    { eventType: 'OCP\\Share\\Events\\ShareCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Share\\Events\\ShareDeletedEvent', actionHandler: 'webhook/automation' },
    // Calendar (OCA\DAV)
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectUpdatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectDeletedEvent', actionHandler: 'webhook/automation' },
    // Deck (OCA\Deck) — CardUpdatedEvent is refined to completed/moved in the webhook
    { eventType: 'OCA\\Deck\\Event\\CardCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Deck\\Event\\CardUpdatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Deck\\Event\\CardDeletedEvent', actionHandler: 'webhook/automation' },
    // Talk (OCA\Talk / spreed)
    { eventType: 'OCA\\Talk\\Events\\ChatMessageSentEvent', actionHandler: 'webhook/automation' },
];

// Subscribe to NC user/group events so we can mirror them into Bee Flow
// in real time. The connector's /webhook/nc-events endpoint receives the
// callbacks and forwards them (HMAC-signed) to the SaaS.
//
// Idempotent: NC enforces a unique constraint on (appId, eventType,
// actionHandler) and returns 409 on duplicate. We swallow 409.
//
// Parallelised via Promise.allSettled so worst-case is the timeout of a
// single call (3s), not N × 3s. NC 33.0.0 / AppAPI 33.0.0 has a broken
// EventsListenerController that always returns 500 — we detect that on
// the first response and skip the rest.
async function registerEventListeners() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/events_listener`;
    const PER_CALL_TIMEOUT_MS = 3_000;

    // Probe one event first. If NC responds with the EventsListenerController
    // error, the rest will all fail the same way — skip them.
    const probeResult = await registerOne(url, SUBSCRIBED_EVENTS[0], PER_CALL_TIMEOUT_MS);
    if (probeResult.unsupportedVersion) {
        console.log('[Init] AppAPI on this Nextcloud version does not implement events_listener — real-time user/group sync disabled. Periodic backstop and manual "Sync now" remain available.');
        return;
    }
    if (probeResult.error) {
        console.warn(`[Init] events_listener probe failed: ${probeResult.error}`);
    }

    // Probe ok — fan out the rest in parallel.
    const rest = SUBSCRIBED_EVENTS.slice(1);
    const results = await Promise.allSettled(
        rest.map(ev => registerOne(url, ev, PER_CALL_TIMEOUT_MS))
    );
    let failed = 0;
    for (const r of results) {
        if (r.status === 'rejected' || (r.value && r.value.error)) failed++;
    }
    console.log(`[Init] Event listeners registered (${SUBSCRIBED_EVENTS.length - failed}/${SUBSCRIBED_EVENTS.length})`);
}

async function registerOne(url, ev, timeoutMs) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: appApiHeaders(),
            body: JSON.stringify({ eventType: ev.eventType, actionHandler: ev.actionHandler, eventSubtypes: [] }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok || res.status === 409) return { ok: true };
        const body = await res.text().catch(() => '');
        if (res.status >= 500 && /EventsListenerController/i.test(body)) {
            return { unsupportedVersion: true };
        }
        return { error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
    } catch (err) {
        return { error: err.message };
    }
}

// Called from process signal handlers. Best-effort: if NC is already
// gone or unreachable, we just exit — stale entries will be cleaned up
// by the next /init.
async function unregisterEventListeners() {
    if (!config.nextcloudUrl) return;
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/events_listener`;
    await Promise.allSettled(SUBSCRIBED_EVENTS.map(ev =>
        fetch(url, {
            method: 'DELETE',
            headers: appApiHeaders(),
            body: JSON.stringify({ eventType: ev.eventType, actionHandler: ev.actionHandler }),
            signal: AbortSignal.timeout(2_000),
        }).catch(() => {})
    ));
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
    const res = await fetch(url, {
        method: 'PUT',
        headers: appApiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
        throw new Error(`Status report failed: HTTP ${res.status}`);
    }
}

module.exports = { registerLifecycle, unregisterEventListeners, runInitInBackground };
