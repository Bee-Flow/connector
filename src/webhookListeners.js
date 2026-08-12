/**
 * Nextcloud `webhook_listeners` registration.
 *
 * Replaces the previous AppAPI `events_listener` integration, which no longer
 * exists: there is no `EventsListenerController` in app_api, no
 * `/apps/app_api/api/v1/events_listener` route in `appinfo/routes.php`, and no
 * mention of it in any of app_api's three OpenAPI specs. AppAPI now only
 * *cleans up* webhook_listeners rows when an ExApp is unregistered
 * (`ExAppService::unregisterExAppWebhooks` → `WebhookListenerMapper::deleteByAppId`),
 * which is the clearest signal that this is the supported path for ExApps.
 *
 * `webhook_listeners` is bundled with Nextcloud (`occ app:enable webhook_listeners`)
 * and is strictly more capable than the API it replaced:
 *
 *   - `event` is the fully-qualified PHP class name, so one row per event class
 *     (the old API only ever supported the coarse `node_event` category).
 *   - `eventFilter` is a Mongo-style query evaluated server-side against the
 *     whole envelope, so path/user prefiltering happens inside Nextcloud.
 *   - `authMethod: 'header'` + `authData` authenticates Nextcloud → connector.
 *
 * We deliberately do NOT request `tokenNeeded`. Nextcloud can attach ephemeral
 * (1 hour) credentials for the triggering user to every delivery, which is how
 * Windmill acts on the user's behalf — but Bee Flow already impersonates any
 * Nextcloud user through AppAPI's shared secret (see ncProxy.js), with no
 * expiry, no per-user setup and no credential on the wire. Push delivery
 * implies the connector is installed, so that path is always available here.
 * Asking Nextcloud to mint credentials we would immediately discard would put
 * a real user token in a webhook body and in our logs' blast radius for no
 * capability we don't already have.
 *
 * (There is also an upstream caveat: `WebhooksController::create` silently
 * nulls `tokenNeeded` unless a real admin *user session* is present, so an
 * ExApp registering with only its shared secret would not receive them anyway.)
 *
 * IMPORTANT — only event classes implementing `OCP\EventDispatcher\IWebhookCompatibleEvent`
 * may be registered. `WebhooksEventListener::serializeEvent()` calls
 * `getWebhookSerializable()` unconditionally, so registering an incompatible
 * class produces a fatal error inside a Nextcloud background job rather than a
 * clean failure here. Verified compatible upstream: Files `Node*` events,
 * `OCP\SystemTag\Tag{Assigned,Unassigned}Event`, the `OCP\Calendar\Events\CalendarObject*`
 * family, `OCA\Forms\Events\FormSubmittedEvent`, `OCA\Tables\Event\Row*Event`,
 * and — since Deck v1.18.0 (2026-05-03) — `OCA\Deck\Event\Card{Created,Updated,Deleted}Event`
 * via `ACardEvent`. Verified NOT compatible: `OCP\Share\Events\*`, which still
 * `extends Event` with no webhook interface on server HEAD. Talk is handled by
 * the Talk-bot webhook instead (its events are not compatible either). Do not
 * add classes to EVENTS below without checking the interface first.
 *
 * Deck's `AAclEvent` subclasses (`Acl{Created,Updated,Deleted}Event`) and
 * `BoardUpdatedEvent` are ALSO webhook-compatible and deliberately not
 * registered: Bee Flow's trigger catalogue has no event id for board or ACL
 * changes, so subscribing would buy nothing but deliveries the handler answers
 * with `{ignored}`. Add the catalogue entry first, then the class here.
 *
 * Delivery latency note: webhook_listeners dispatches through background jobs,
 * so out of the box latency is the cron interval (5 minutes). Admins who want
 * near-real-time delivery must run dedicated workers:
 *   occ background-job:worker -t 60 'OCA\WebhookListeners\BackgroundJobs\WebhookCall'
 */

const crypto = require('crypto');
const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const WEBHOOKS_API = '/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks';

// Path the connector exposes for deliveries. Declared PUBLIC in appinfo/info.xml
// (`^/?hooks/.*`) because Nextcloud's background job calls it with no user
// session; the shared secret in `authData` is what authenticates it.
const HOOK_PATH = '/hooks/nextcloud';

/**
 * Event classes we subscribe to, and the Bee Flow trigger id each maps to.
 * `optional: true` marks classes that only exist when an optional app is
 * installed — registration failures for those are logged once at debug level
 * instead of counted as errors.
 */
const EVENTS = [
    // ── Files ────────────────────────────────────────────────────────────
    { class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', event: 'file.new' },
    { class: 'OCP\\Files\\Events\\Node\\NodeWrittenEvent', event: 'file.changed' },
    { class: 'OCP\\Files\\Events\\Node\\NodeDeletedEvent', event: 'file.deleted' },
    { class: 'OCP\\Files\\Events\\Node\\NodeRenamedEvent', event: 'file.renamed' },
    { class: 'OCP\\Files\\Events\\Node\\NodeCopiedEvent', event: 'file.copied' },
    { class: 'OCP\\Files\\Events\\Node\\NodeRestoredEvent', event: 'file.restored' },
    // ── System tags ──────────────────────────────────────────────────────
    { class: 'OCP\\SystemTag\\TagAssignedEvent', event: 'file.tagged' },
    { class: 'OCP\\SystemTag\\TagUnassignedEvent', event: 'file.untagged' },
    // ── Calendar ─────────────────────────────────────────────────────────
    { class: 'OCP\\Calendar\\Events\\CalendarObjectCreatedEvent', event: 'calendar.event.created' },
    { class: 'OCP\\Calendar\\Events\\CalendarObjectUpdatedEvent', event: 'calendar.event.changed' },
    { class: 'OCP\\Calendar\\Events\\CalendarObjectDeletedEvent', event: 'calendar.event.deleted' },
    { class: 'OCP\\Calendar\\Events\\CalendarObjectMovedEvent', event: 'calendar.event.moved' },
    // ── Forms (optional app) ─────────────────────────────────────────────
    { class: 'OCA\\Forms\\Events\\FormSubmittedEvent', event: 'forms.submitted', optional: true },
    // ── Tables (optional app) ────────────────────────────────────────────
    { class: 'OCA\\Tables\\Event\\RowAddedEvent', event: 'tables.row.added', optional: true },
    { class: 'OCA\\Tables\\Event\\RowUpdatedEvent', event: 'tables.row.updated', optional: true },
    { class: 'OCA\\Tables\\Event\\RowDeletedEvent', event: 'tables.row.deleted', optional: true },
    // ── Deck (optional app, NC Deck >= 1.18.0) ───────────────────────────
    // `deck.card.completed` and `deck.card.moved` are DERIVED from the update
    // event rather than registered — Deck has no distinct class for either, and
    // `CardUpdatedEvent` inherits `ACardEvent::getWebhookSerializable()`, which
    // serialises only the current card. `cardBefore` exists on the PHP object
    // and never reaches the wire. See deckTransitions() in
    // automationEventsWebhook.js for how the transition is recovered.
    { class: 'OCA\\Deck\\Event\\CardCreatedEvent', event: 'deck.card.created', optional: true },
    { class: 'OCA\\Deck\\Event\\CardUpdatedEvent', event: 'deck.card.changed', optional: true },
    { class: 'OCA\\Deck\\Event\\CardDeletedEvent', event: 'deck.card.deleted', optional: true },
];

// Reverse lookup used by the delivery handler: class name → Bee Flow event id.
const EVENT_BY_CLASS = Object.freeze(
    Object.fromEntries(EVENTS.map(e => [e.class, e.event]))
);

/**
 * Secret Nextcloud sends back to us on every delivery, as
 * `X-Beeflow-Hook-Secret`. Derived from the tenant key rather than being the
 * tenant key, so the value stored in Nextcloud's database is useless against
 * the `/nc/*` proxy. Deterministic, so re-registration is stable and rotating
 * the tenant key rotates this too.
 */
function hookSecret() {
    if (!config.tenantKey) return null;
    return crypto.createHmac('sha256', config.tenantKey)
        .update('beeflow:webhook-listener:v1')
        .digest('hex');
}

function hookUri() {
    // Nextcloud calls itself; AppAPI's ExApp proxy forwards to us. This is the
    // same reachability path bootstrap.js uses for connector_callback_url, so
    // it needs no extra network configuration.
    const ncBase = config.nextcloudPublicUrl || config.nextcloudUrl;
    return `${ncBase}/index.php/apps/app_api/proxy/${config.appId}${HOOK_PATH}`;
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

function ocsData(body) {
    try {
        return JSON.parse(body)?.ocs?.data ?? null;
    } catch (_) {
        return null;
    }
}

/** Body for one webhook row. See the header for why `tokenNeeded` is absent. */
function webhookBody(entry, secret) {
    return {
        httpMethod: 'POST',
        uri: hookUri(),
        event: entry.class,
        eventFilter: {},
        userIdFilter: null,
        headers: {
            'X-Beeflow-Hook-Event': entry.event,
            ...(config.ncInstanceId ? { 'X-Beeflow-NC-Instance-Id': config.ncInstanceId } : {}),
        },
        authMethod: 'header',
        authData: { 'X-Beeflow-Hook-Secret': secret },
    };
}

/** Existing rows for our callback URI, keyed by event class. */
async function listExisting() {
    const url = `${config.nextcloudUrl}${WEBHOOKS_API}?uri=${encodeURIComponent(hookUri())}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: appApiHeaders(),
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
        // 404 → the app isn't enabled. Distinguish so the caller can say so.
        const err = new Error(`webhook list HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const rows = ocsData(await res.text()) || [];
    const byClass = new Map();
    for (const row of rows) {
        if (row && row.event) byClass.set(row.event, row);
    }
    return byClass;
}

async function upsertOne(entry, existing, secret) {
    const body = webhookBody(entry, secret);
    const row = existing.get(entry.class);
    // Update in place when a row already exists so repeated /init calls don't
    // accumulate duplicates (Nextcloud does not deduplicate by (uri, event)).
    const url = row?.id
        ? `${config.nextcloudUrl}${WEBHOOKS_API}/${row.id}`
        : `${config.nextcloudUrl}${WEBHOOKS_API}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { ok: true, updated: !!row?.id };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text.slice(0, 160) };
}

let _registered = false;
let _retryTimer = null;

/**
 * Register (or refresh) every webhook row. Idempotent: safe to call on every
 * /init and from the retry timer.
 *
 * Returns { ok, registered, skipped, failed, reason }.
 */
async function ensureWebhookListeners() {
    const secret = hookSecret();
    if (!secret) {
        return { ok: false, reason: 'no-tenant-key', registered: 0, skipped: 0, failed: 0 };
    }

    let existing;
    try {
        // The list call is the capability probe: a 404 means webhook_listeners
        // is disabled, and there is no point fanning out 16 registrations.
        existing = await withWarmupRetry(() => listExisting(), {
            label: 'webhook-listeners-list',
            budgetMs: 30_000,
        });
    } catch (err) {
        if (err.status === 404) {
            console.warn('[Webhooks] The webhook_listeners app is not enabled on this Nextcloud — '
                + 'push triggers are unavailable. Enable it with `occ app:enable webhook_listeners`. '
                + 'Polling-based triggers keep working.');
            return { ok: false, reason: 'app-disabled', registered: 0, skipped: 0, failed: 0 };
        }
        console.warn(`[Webhooks] Could not list existing webhooks: ${err.message}`);
        return { ok: false, reason: 'list-failed', registered: 0, skipped: 0, failed: 0 };
    }

    let registered = 0;
    let skipped = 0;
    let failed = 0;
    const results = await Promise.allSettled(
        EVENTS.map(entry => upsertOne(entry, existing, secret).then(r => ({ entry, r })))
    );
    for (const settled of results) {
        if (settled.status === 'rejected') { failed++; continue; }
        const { entry, r } = settled.value;
        if (r.ok) { registered++; continue; }
        if (entry.optional) {
            // Forms/Tables not installed — expected, not an error.
            skipped++;
            console.log(`[Webhooks] Skipped ${entry.event} (${entry.class}) — app not installed (HTTP ${r.status})`);
            continue;
        }
        failed++;
        console.warn(`[Webhooks] Register failed for ${entry.event}: HTTP ${r.status} ${r.body}`);
    }

    console.log(`[Webhooks] ${registered} registered, ${skipped} skipped (optional apps), ${failed} failed`);
    if (registered > 0 && failed === 0) {
        _registered = true;
        stopRetry();
    }
    return { ok: failed === 0, registered, skipped, failed };
}

/**
 * Keep trying until registration succeeds. Bootstrap may still be in flight
 * when /init runs (no tenant key yet), and an admin may enable
 * webhook_listeners after installing us.
 */
function startRetry(intervalMs = 60_000) {
    if (_retryTimer || _registered) return;
    _retryTimer = setInterval(() => {
        ensureWebhookListeners().catch(err =>
            console.warn(`[Webhooks] retry failed: ${err.message}`));
    }, intervalMs);
    _retryTimer.unref?.();
}

function stopRetry() {
    if (_retryTimer) {
        clearInterval(_retryTimer);
        _retryTimer = null;
    }
}

/**
 * Best-effort teardown on shutdown. AppAPI also removes our rows by appId when
 * the ExApp is unregistered, so this is belt-and-braces for a plain restart of
 * a reconfigured connector.
 */
async function unregisterWebhookListeners() {
    stopRetry();
    if (!config.nextcloudUrl || !config.tenantKey) return;
    let existing;
    try {
        existing = await listExisting();
    } catch (_) {
        return;
    }
    await Promise.allSettled([...existing.values()].map(row =>
        fetch(`${config.nextcloudUrl}${WEBHOOKS_API}/${row.id}`, {
            method: 'DELETE',
            headers: appApiHeaders(),
            signal: AbortSignal.timeout(2_000),
        }).catch(() => {})
    ));
}

module.exports = {
    ensureWebhookListeners,
    unregisterWebhookListeners,
    startRetry,
    stopRetry,
    hookSecret,
    hookUri,
    EVENTS,
    EVENT_BY_CLASS,
    HOOK_PATH,
    // exported for tests
    webhookBody,
};
