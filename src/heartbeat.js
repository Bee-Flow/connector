/**
 * ExApp lifecycle endpoints.
 *
 * Contract: https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 *   GET  /heartbeat     — unauthenticated, must respond within 10 min of start
 *   POST /init          — authenticated, optional setup; report progress 1-100
 *   PUT  /enabled?...   — authenticated, registers/unregisters NC-side hooks
 */

const config = require('./config');

function registerLifecycle(app) {
    app.get('/heartbeat', (req, res) => {
        res.json({ status: 'ok' });
    });

    // /init runs once per install. We do a best-effort SaaS probe so the
    // admin sees a warning if upstream is unreachable, but install never
    // fails on it — a transient SaaS outage shouldn't block the connector
    // from coming up. AppAPI expects progress on
    // /ocs/v2.php/apps/app_api/ex-app/status; we report 100 immediately
    // because there's no model download or migration to run on our side.
    app.post('/init', async (req, res) => {
        // Retry bootstrap if startup attempt failed — by /init time the SaaS
        // is reachable and we have a stable HOSTNAME, so this is a more
        // reliable point than initial container boot.
        if (!config.tenantKey && config.isAutoTenantKey) {
            try {
                const { bootstrapIfNeeded } = require('./bootstrap');
                await bootstrapIfNeeded();
            } catch (err) {
                console.warn(`[Init] Bootstrap retry failed (non-fatal): ${err.message}`);
            }
        }
        try {
            const probe = await fetch(`${config.apiBaseUrl}/api/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(5_000),
            });
            if (!probe.ok) {
                console.warn(`[Init] SaaS health probe returned HTTP ${probe.status} — continuing`);
            }
        } catch (err) {
            console.warn(`[Init] SaaS health probe failed (non-fatal): ${err.message}`);
        }
        await registerTopMenu().catch(err => {
            console.warn(`[Init] TopMenu registration failed (non-fatal): ${err.message}`);
        });
        await registerEmbedScript().catch(err => {
            console.warn(`[Init] Embed script registration failed (non-fatal): ${err.message}`);
        });
        await registerEventListeners().catch(err => {
            console.warn(`[Init] Event listener registration failed (non-fatal): ${err.message}`);
        });
        await reportInitProgress(100).catch(err => {
            console.warn(`[Init] Progress report failed (non-fatal): ${err.message}`);
        });
        res.json({ status: 'ok' });
    });

    app.put('/enabled', (req, res) => {
        const enabled = req.query.enabled === '1';
        console.log(`[Lifecycle] enabled=${enabled}`);
        // Future: register/unregister navigation entry, dashboard widget, etc.
        // For v0.1.0 the navigation entry is declared statically in info.xml.
        res.json({ status: 'ok' });
    });
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
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
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
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Script register HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log('[Init] Embed script registered');
}

// Canonical list of events the connector subscribes to. Single source of
// truth so register + unregister + cleanup all stay in sync.
//
// Two action-handlers split the work:
//   - 'webhook/nc-events'    → user/group events (forwarded to SaaS user-sync)
//   - 'webhook/automation'   → trigger events for the Automations engine
//
// The handler field is the connector-relative path NC will POST to; the
// connector then signs+forwards to the SaaS at the appropriate endpoint.
const SUBSCRIBED_EVENTS = [
    // ── User/group sync (legacy, untouched) ───────────────────────────
    { eventType: 'OCP\\User\\Events\\UserCreatedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\User\\Events\\UserDeletedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\User\\Events\\UserChangedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\Group\\Events\\UserAddedEvent', actionHandler: 'webhook/nc-events' },
    { eventType: 'OCP\\Group\\Events\\UserRemovedEvent', actionHandler: 'webhook/nc-events' },

    // ── Files / shares / comments / tags ──────────────────────────────
    { eventType: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeWrittenEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeDeletedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Files\\Events\\Node\\NodeRenamedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Files_Sharing\\Event\\ShareCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Files_Sharing\\Event\\ShareAcceptedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Files_Sharing\\Event\\ShareDeletedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\Comments\\CommentsEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCP\\SystemTag\\ManagerEvent', actionHandler: 'webhook/automation' },

    // ── Calendar / DAV ────────────────────────────────────────────────
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectUpdatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\DAV\\Events\\CalendarObjectDeletedEvent', actionHandler: 'webhook/automation' },

    // ── Deck (kanban) ─────────────────────────────────────────────────
    { eventType: 'OCA\\Deck\\Event\\CardCreatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Deck\\Event\\CardUpdatedEvent', actionHandler: 'webhook/automation' },
    { eventType: 'OCA\\Deck\\Event\\CardDeletedEvent', actionHandler: 'webhook/automation' },

    // ── Talk (chat) ───────────────────────────────────────────────────
    { eventType: 'OCA\\Talk\\Events\\ChatMessageSentEvent', actionHandler: 'webhook/automation' },
];

// Subscribe to NC user/group events so we can mirror them into Bee Flow
// in real time. The connector's /webhook/nc-events endpoint receives the
// callbacks and forwards them (HMAC-signed) to the SaaS.
//
// Idempotent: NC enforces a unique constraint on (appId, eventType,
// actionHandler) and returns 409 on duplicate. We swallow 409. On NC
// versions exposing GET we additionally prune stale listeners pointing
// at our actionHandler but for an event we no longer support.
async function registerEventListeners() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/events_listener`;

    // Best-effort cleanup of stale listeners (event-class no longer in our list)
    try {
        const list = await fetch(url, {
            method: 'GET',
            headers: appApiHeaders(),
            signal: AbortSignal.timeout(10_000),
        });
        if (list.ok) {
            const body = await list.json().catch(() => null);
            const existing = body?.ocs?.data || body?.data || (Array.isArray(body) ? body : []);
            const wantedSet = new Set(SUBSCRIBED_EVENTS.map(e => `${e.eventType}::${e.actionHandler}`));
            for (const sub of existing) {
                const evType = sub?.eventType || sub?.event_type;
                const handler = sub?.actionHandler || sub?.action_handler;
                if (!evType || !handler) continue;
                if (handler !== 'webhook/nc-events') continue;
                if (wantedSet.has(`${evType}::${handler}`)) continue;
                try {
                    await fetch(url, {
                        method: 'DELETE',
                        headers: appApiHeaders(),
                        body: JSON.stringify({ eventType: evType, actionHandler: handler }),
                        signal: AbortSignal.timeout(10_000),
                    });
                    console.log(`[Init] Removed stale listener ${evType}`);
                } catch { /* non-fatal */ }
            }
        }
    } catch { /* GET unsupported on this NC version — fall through */ }

    let unsupportedVersion = false;
    for (const ev of SUBSCRIBED_EVENTS) {
        if (unsupportedVersion) break;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: appApiHeaders(),
                body: JSON.stringify({ eventType: ev.eventType, actionHandler: ev.actionHandler, eventSubtypes: [] }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok && res.status !== 409) {
                const body = await res.text().catch(() => '');
                // Some AppAPI builds (e.g. NC 33.0.3 / AppAPI 33.0.0) ship a
                // routes file referencing EventsListenerController without the
                // class — the endpoint always 500s. There is no point retrying
                // for the next 4 events; bail with a single explanatory log.
                if (res.status >= 500 && /EventsListenerController/i.test(body)) {
                    console.log('[Init] AppAPI on this Nextcloud version does not implement events_listener — real-time user/group sync disabled. Periodic backstop and manual "Sync now" remain available.');
                    unsupportedVersion = true;
                    break;
                }
                console.warn(`[Init] events_listener ${ev.eventType} HTTP ${res.status}: ${body.slice(0, 120)}`);
            }
        } catch (err) {
            console.warn(`[Init] events_listener ${ev.eventType} failed: ${err.message}`);
        }
    }
    if (!unsupportedVersion) console.log('[Init] Event listeners registered');
}

// Called from process signal handlers. Best-effort: if NC is already
// gone or unreachable, we just exit — stale entries will be cleaned up
// by the next /init.
async function unregisterEventListeners() {
    if (!config.nextcloudUrl) return;
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/events_listener`;
    for (const ev of SUBSCRIBED_EVENTS) {
        try {
            await fetch(url, {
                method: 'DELETE',
                headers: appApiHeaders(),
                body: JSON.stringify({ eventType: ev.eventType, actionHandler: ev.actionHandler }),
                signal: AbortSignal.timeout(3_000),
            });
        } catch { /* swallow on shutdown */ }
    }
}

async function reportInitProgress(percent) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/apps/app_api/ex-app/status`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'OCS-APIRequest': 'true',
            'EX-APP-ID': config.appId,
            'EX-APP-VERSION': config.appVersion,
            'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
        },
        body: JSON.stringify({ progress: percent }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new Error(`Status report failed: HTTP ${res.status}`);
    }
}

module.exports = { registerLifecycle, unregisterEventListeners };
