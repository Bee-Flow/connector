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
const rateLimit = require('./rateLimit');

// Brute-force gate on the hook secret. Nextcloud's background job always sends
// the right one, so only failures are billed and real deliveries never throttle.
const secretLimiter = rateLimit.penalise('nc-hook-secret', { limit: 60, windowMs: 60_000 });

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

    if (event.startsWith('deck.card.')) {
        const c = (e.card && typeof e.card === 'object') ? e.card : {};
        return {
            cardId: c.id ?? null,
            title: c.title ?? null,
            description: c.description ?? null,
            stackId: c.stackId ?? null,
            boardId: c.boardId ?? null,
            // Deck's `done` is an ISO timestamp when complete, null otherwise.
            // Passed through as-is: "when was it finished" is more useful to a
            // routine than a boolean, and truthiness still reads as "is done".
            done: c.done ?? null,
            archived: c.archived ?? null,
            duedate: c.duedate ?? null,
            labels: Array.isArray(c.labels) ? c.labels.map(l => l?.title).filter(Boolean) : [],
            assignedUsers: Array.isArray(c.assignedUsers)
                ? c.assignedUsers.map(a => a?.participant?.uid || a?.participant?.primaryKey).filter(Boolean)
                : [],
            ...base,
        };
    }

    // Unknown-but-registered class: forward the serialized event as-is rather
    // than dropping data the SaaS might understand.
    return { ...e, ...base };
}

/**
 * Deck card transitions, recovered by remembering the last state we saw.
 *
 * Deck fires ONE class for every card mutation — `CardUpdatedEvent` — and its
 * webhook payload is `ACardEvent::getWebhookSerializable()`, i.e. the current
 * card and nothing else. The `cardBefore` the PHP event carries is never
 * serialised, so "moved to another stack" and "marked done" are
 * indistinguishable from "someone fixed a typo" on the wire.
 *
 * Bee Flow's catalogue has had `deck.card.moved` and `deck.card.completed`
 * since before any of this could fire, and the `nc-deck-done-celebrate`
 * template subscribes to the latter. So the transition is reconstructed here
 * from a bounded cache of the last state per card.
 *
 * FAILURE MODE, deliberately chosen: a cache miss — first sighting, a restart,
 * an eviction, or a second replica that has not seen this card — yields NO
 * transition event, only `deck.card.changed`. Never a false positive. The
 * alternative (firing `completed` whenever `done` is merely set) would re-fire
 * on every subsequent edit of an already-finished card, which is the kind of
 * trigger that gets a routine switched off.
 */
const CARD_STATE = new Map();
const CARD_STATE_MAX = 5000;

function rememberCard(cardId, state) {
    if (cardId == null) return;
    // Re-insert so the Map's insertion order is a true LRU tail.
    CARD_STATE.delete(cardId);
    CARD_STATE.set(cardId, state);
    while (CARD_STATE.size > CARD_STATE_MAX) {
        CARD_STATE.delete(CARD_STATE.keys().next().value);
    }
}

function deckTransitions(event, payload) {
    const id = payload?.cardId;
    if (id == null) return [];
    const next = { done: payload.done ?? null, stackId: payload.stackId ?? null };

    if (event === 'deck.card.deleted') { CARD_STATE.delete(id); return []; }
    if (event === 'deck.card.created') { rememberCard(id, next); return []; }
    if (event !== 'deck.card.changed') return [];

    const prev = CARD_STATE.get(id);
    rememberCard(id, next);
    if (!prev) return [];

    // The cache is the only place the card's previous stack exists, so the
    // payload is annotated here rather than in normalisePayload. `moved`
    // without a "from" is half an event — a routine that files a card by where
    // it came from cannot work without it.
    if (prev.stackId != null) payload.previousStackId = prev.stackId;

    const extra = [];
    if (!prev.done && next.done) extra.push('deck.card.completed');
    if (prev.stackId != null && next.stackId != null && prev.stackId !== next.stackId) {
        extra.push('deck.card.moved');
    }
    return extra;
}

const router = express.Router();

// express.json is not mounted globally for this path (see server.js — the raw
// body must survive for /nc/*), so parse here.
router.post(HOOK_PATH, express.json({ limit: '512kb' }), async (req, res) => {
    const secret = hookSecret();
    if (!secret) return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    if (secretLimiter.blocked()) {
        res.set('Retry-After', String(Math.ceil(secretLimiter.windowMs / 1000)));
        return res.status(429).json({ error: 'Too many invalid hook secrets' });
    }
    if (!safeEqual(req.headers['x-beeflow-hook-secret'], secret)) {
        secretLimiter.fail();
        return res.status(401).json({ error: 'Invalid hook secret' });
    }
    secretLimiter.succeed();

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

    // One Nextcloud delivery can be more than one Bee Flow event: a Deck card
    // update that also completed the card is both `changed` and `completed`.
    // Both are sent — a routine on `changed` should still fire, and the
    // narrower trigger is the one most authors reach for.
    const events = [event, ...deckTransitions(event, payload)];

    for (const name of events) {
        // Note the omission: `envelope.authentication` is deliberately not read
        // or forwarded. Bee Flow reaches Nextcloud as this user through AppAPI
        // impersonation already (ncProxy.js), so the token would be an unused
        // credential travelling one hop further than it needs to.
        const body = JSON.stringify({ event: name, ncUid, payload });
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
                console.warn(`[AutomationEvents] SaaS returned ${r.status} for ${name}: ${t.slice(0, 200)}`);
            }
        } catch (err) {
            // Keep going: a failure forwarding `changed` must not swallow the
            // `completed` the author actually subscribed to.
            console.warn(`[AutomationEvents] forward failed for ${name}: ${err.message}`);
        }
    }
    // Always 200 to Nextcloud so the background job doesn't enter a retry
    // storm; SaaS failures are logged and recovered by the polling backstop.
    res.json({ ok: true, event, events });
});

module.exports = router;
module.exports.mapEvent = mapEvent;
module.exports.normalisePayload = normalisePayload;
module.exports.toUserRelativePath = toUserRelativePath;
module.exports.deckTransitions = deckTransitions;
module.exports._resetCardState = () => CARD_STATE.clear();
