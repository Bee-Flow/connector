/**
 * Nextcloud `webhook_listeners` deliveries → Bee Flow Automations.
 *
 * Nextcloud POSTs here (via its own AppAPI ExApp proxy — see
 * webhookListeners.hookUri) whenever an event class we registered fires. We
 * translate the envelope into our stable trigger taxonomy, sign it with the
 * tenant key and forward it to the SaaS at /api/automation/events/nextcloud.
 *
 * Envelope (WebhooksEventListener::handle + BackgroundJobs/WebhookCall):
 *
 *   {
 *     "event": { "class": "OCP\\Files\\Events\\Node\\NodeCreatedEvent",
 *                "node": { "id": 437, "path": "/admin/files/test.txt" } },
 *     "user":  { "uid": "admin", "displayName": "Admin" },   // null if no session
 *     "time":  1700100000
 *   }
 *
 * Nextcloud can also attach an `authentication` object with ephemeral per-user
 * tokens, but only when the registration asked for them — ours does not, and
 * webhookListeners.js explains why. If a delivery ever carries one anyway
 * (a stale row from an older connector), it is ignored here rather than
 * forwarded: an unused credential should not travel further than it must.
 *
 * This replaces the previous AppAPI `events_listener` shape
 * (`{event_type, event_subtype, event_data}`), which never arrived because that
 * API has been removed from AppAPI. See webhookListeners.js for the full story.
 *
 * Auth boundary: Nextcloud → connector is authenticated by the
 * `X-Beeflow-Hook-Secret` header, which Nextcloud echoes back from the
 * `authData` we supplied at registration (a value derived from — but not equal
 * to — the tenant key). Connector → SaaS is HMAC-signed with the tenant key
 * over the body. Neither secret leaves its trust zone.
 */

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const { hookSecret, EVENT_BY_CLASS, HOOK_PATH } = require('./webhookListeners');

/** Bee Flow trigger id for a Nextcloud event class, or null if unregistered. */
function mapEvent(eventClass) {
    if (!eventClass || typeof eventClass !== 'string') return null;
    return EVENT_BY_CLASS[eventClass] || null;
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Nextcloud node paths are absolute within the storage layout —
 * `/<uid>/files/Documents/x.pdf`. Every Bee Flow tool and every trigger filter
 * speaks user-relative paths (`/Documents/x.pdf`), so strip the prefix. Paths
 * outside a user's `files` root (versions, trashbin, appdata) are returned
 * unchanged and carry `relative: false` so the SaaS can tell them apart.
 */
function toUserRelativePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return { path: null, owner: null, relative: false };
    const m = /^\/?([^/]+)\/files(\/.*)?$/.exec(rawPath);
    if (!m) return { path: rawPath, owner: null, relative: false };
    return { path: m[2] || '/', owner: m[1], relative: true };
}

function nodeFields(node) {
    if (!node || typeof node !== 'object') {
        return { id: null, path: null, name: null, extension: null, kind: 'file', owner: null };
    }
    const { path, owner } = toUserRelativePath(node.path);
    const name = path ? path.split('/').filter(Boolean).pop() || null : null;
    const extension = name && name.includes('.')
        ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        : null;
    return {
        // `id` is absent on NodeDeletedEvent and on NonExistingFile/Folder —
        // documented upstream. Callers must tolerate null.
        id: node.id ?? null,
        path,
        name,
        extension,
        kind: 'file',
        owner,
    };
}

function normalisePayload(event, envelope) {
    const e = envelope.event || {};
    const actor = envelope.user?.uid || null;
    const actorName = envelope.user?.displayName || null;
    const datetime = envelope.time
        ? new Date(envelope.time * 1000).toISOString()
        : new Date().toISOString();
    const base = { actor, actorName, datetime };

    if (event.startsWith('file.')) {
        // Two-node events (renamed / copied / restored) carry source + target
        // instead of node.
        if (e.source || e.target) {
            const target = nodeFields(e.target);
            const source = nodeFields(e.source);
            return { ...target, oldPath: source.path, sourceId: source.id, ...base, link: null };
        }
        if (event === 'file.tagged' || event === 'file.untagged') {
            return {
                objectType: e.objectType || 'files',
                objectIds: Array.isArray(e.objectIds) ? e.objectIds.map(String) : [],
                fileId: Array.isArray(e.objectIds) && e.objectIds.length ? String(e.objectIds[0]) : null,
                tagIds: Array.isArray(e.tagIds) ? e.tagIds.map(Number) : [],
                tagId: Array.isArray(e.tagIds) && e.tagIds.length ? Number(e.tagIds[0]) : null,
                ...base,
            };
        }
        return { ...nodeFields(e.node), ...base, link: null };
    }

    if (event.startsWith('calendar.')) {
        // The calendar envelope carries object *metadata* only — no VEVENT
        // body, so summary/start/end are not available here. We emit the
        // identifiers needed to fetch the event and leave the rest null so the
        // trigger-bus enrichment step (or a first automation step) can fill
        // them in. `uri` minus the .ics suffix is the CalDAV object UID.
        const obj = e.objectData || {};
        const cal = e.calendarData || e.targetCalendarData || e.sourceCalendarData || {};
        const uri = obj.uri || null;
        return {
            uid: uri ? uri.replace(/\.ics$/i, '') : null,
            objectUri: uri,
            calendarId: e.calendarId ?? e.targetCalendarId ?? e.sourceCalendarId ?? cal.id ?? null,
            calendarUri: cal.uri || null,
            sourceCalendarId: e.sourceCalendarId ?? null,
            targetCalendarId: e.targetCalendarId ?? null,
            component: obj.component || null,
            summary: null,
            startsAt: null,
            endsAt: null,
            location: null,
            ...base,
        };
    }

    if (event === 'forms.submitted') {
        const form = e.form || {};
        const submission = e.submission || {};
        return {
            formId: form.id ?? null,
            formHash: form.hash || null,
            formTitle: form.title || '',
            formOwner: form.ownerId || null,
            submissionId: submission.id ?? null,
            submittedBy: submission.userId || actor,
            submittedAt: submission.timestamp
                ? new Date(submission.timestamp * 1000).toISOString()
                : datetime,
            ...base,
        };
    }

    if (event.startsWith('tables.row.')) {
        return {
            tableId: e.tableId ?? null,
            rowId: e.rowId ?? null,
            values: e.values && typeof e.values === 'object' ? e.values : {},
            previousValues: e.previousValues && typeof e.previousValues === 'object'
                ? e.previousValues
                : null,
            ...base,
        };
    }

    // Unknown-but-registered class: forward the serialized event as-is rather
    // than dropping data the SaaS might understand.
    return { ...e, ...base };
}

const router = express.Router();

// express.json is not mounted globally for this path (see server.js — the raw
// body must survive for /nc/*), so parse here.
router.post(HOOK_PATH, express.json({ limit: '512kb' }), async (req, res) => {
    const secret = hookSecret();
    if (!secret) return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    if (!safeEqual(req.headers['x-beeflow-hook-secret'], secret)) {
        return res.status(401).json({ error: 'Invalid hook secret' });
    }

    const envelope = req.body || {};
    const eventClass = envelope.event?.class;
    const event = mapEvent(eventClass);
    if (!event) {
        // 200 so Nextcloud doesn't keep retrying a class we no longer handle
        // (e.g. a stale row left by an older connector version).
        return res.json({ ignored: eventClass || null });
    }

    if (!config.ncInstanceId) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    const ncUid = envelope.user?.uid || null;
    const payload = normalisePayload(event, envelope);

    // Note the omission: `envelope.authentication` is deliberately not read or
    // forwarded. Bee Flow reaches Nextcloud as this user through AppAPI
    // impersonation already (ncProxy.js), so the token would be an unused
    // credential travelling one hop further than it needs to.
    const body = JSON.stringify({ event, ncUid, payload });
    const ts = Math.floor(Date.now() / 1000);
    const path = '/api/automation/events/nextcloud';
    const message = `${ts}\nPOST\n${path}\n${body}`;
    const sig = crypto.createHmac('sha256', config.tenantKey).update(message).digest('hex');

    try {
        const r = await fetch(`${config.apiBaseUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Beeflow-Source': 'nextcloud-connector',
                'X-Beeflow-NC-Instance-Id': config.ncInstanceId,
                'X-Beeflow-Sig': `${ts}.${sig}`,
            },
            body,
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.warn(`[AutomationEvents] SaaS returned ${r.status}: ${t.slice(0, 200)}`);
        }
    } catch (err) {
        console.warn(`[AutomationEvents] forward failed: ${err.message}`);
    }
    // Always 200 to Nextcloud so the background job doesn't enter a retry
    // storm; SaaS failures are logged and recovered by the polling backstop.
    res.json({ ok: true, event });
});

module.exports = router;
module.exports.mapEvent = mapEvent;
module.exports.normalisePayload = normalisePayload;
module.exports.toUserRelativePath = toUserRelativePath;
