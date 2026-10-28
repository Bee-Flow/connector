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
const log = require('./log');
const { errMessage } = require('./errors');

// Brute-force gate on the hook secret. Nextcloud's background job always sends
// the right one, so only failures are billed and real deliveries never throttle.
/**
 * What Nextcloud's webhook_listeners app posts for one event. The shape depends on the event class, so
 * every field is optional and only the ones a mapper below reads are listed.
 *
 * @typedef {object} HookNode
 * @property {string | number} [id]
 * @property {string} [path]
 *
 * @typedef {object} HookCard
 * @property {string | number} [id]
 * @property {string} [title]
 * @property {string | null} [description]
 * @property {string | number} [stackId]
 * @property {string | number} [boardId]
 * @property {string | boolean | null} [done]
 * @property {string | boolean | null} [archived]
 * @property {string | null} [duedate]
 * @property {({ title?: string } | null)[]} [labels]
 * @property {({ participant?: { uid?: string, primaryKey?: string } } | null)[]} [assignedUsers]
 *
 * @typedef {{ id?: string | number, uri?: string, principaluri?: string }} HookCalendar
 *
 * One calendar share as Nextcloud's DAV sharing backend serialises it. Only the
 * principal and the access are read; `commonName` (a display name) never is.
 * @typedef {{ '{http://owncloud.org/ns}principal'?: string, href?: string, readOnly?: boolean, commonName?: string }} HookShare
 *
 * @typedef {object} HookEventBody
 * @property {string} [class]
 * @property {HookNode} [node]
 * @property {HookNode} [source]
 * @property {HookNode} [target]
 * @property {string} [objectType]
 * @property {(string | number)[]} [objectIds]
 * @property {(string | number)[]} [tagIds]
 * @property {{ uri?: string, component?: string }} [objectData]
 * @property {HookCalendar} [calendarData]
 * @property {HookCalendar} [targetCalendarData]
 * @property {HookCalendar} [sourceCalendarData]
 * @property {HookShare[]} [shares]
 * @property {HookShare[]} [targetShares]
 * @property {HookShare[]} [sourceShares]
 * @property {string | number} [calendarId]
 * @property {string | number} [targetCalendarId]
 * @property {string | number} [sourceCalendarId]
 * @property {{ id?: string | number, hash?: string, title?: string, ownerId?: string }} [form]
 * @property {{ id?: string | number, userId?: string, timestamp?: number }} [submission]
 * @property {string | number} [tableId]
 * @property {string | number} [rowId]
 * @property {Record<string, unknown>} [values]
 * @property {Record<string, unknown>} [previousValues]
 * @property {HookCard} [card]
 *
 * @typedef {object} HookEnvelope
 * @property {HookEventBody} [event]
 * @property {{ uid?: string, displayName?: string }} [user]
 * @property {number} [time]  unix seconds
 *
 * The normalised payload sent on to the SaaS. The deck fields are named because deckTransitions()
 * reads and writes them; the rest differs per event.
 * @typedef {{
 *   [key: string]: unknown,
 *   cardId?: string | number | null,
 *   done?: string | boolean | null,
 *   stackId?: string | number | null,
 *   previousStackId?: string | number,
 * }} HookPayload
 */

const secretLimiter = rateLimit.penalise('nc-hook-secret', { limit: 60, windowMs: 60_000 });

// File events whose node still exists when the webhook fires, so Nextcloud
// can say whether it is a file or a folder.
const NODE_TYPE_EVENTS = new Set(['file.new', 'file.changed', 'file.renamed', 'file.copied', 'file.restored']);
const NODE_TYPE_TIMEOUT_MS = 3_000;
const PROPFIND_RESOURCETYPE = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

/**
 * File or folder, asked of Nextcloud as the node's owner (one WebDAV PROPFIND
 * for its resourcetype). The webhook envelope carries only id and path, so
 * the server had to guess from the name (#407). Null when Nextcloud does not
 * say: the server then keeps its guess. Best effort, short timeout.
 * @param {string | null} owner
 * @param {string | null} relPath  user-relative path ("/Documents/x.pdf")
 * @returns {Promise<'file' | 'folder' | null>}
 */
async function nodeTypeOf(owner, relPath) {
    if (!owner || !relPath || !relPath.startsWith('/')) return null;
    const encoded = relPath.split('/').map(encodeURIComponent).join('/');
    try {
        const res = await fetch(`${config.nextcloudUrl}/remote.php/dav/files/${encodeURIComponent(owner)}${encoded}`, {
            method: 'PROPFIND',
            headers: {
                'Depth': '0',
                'Content-Type': 'application/xml; charset=utf-8',
                'EX-APP-ID': config.appId,
                'EX-APP-VERSION': config.appVersion,
                'AUTHORIZATION-APP-API': Buffer.from(`${owner}:${config.appSecret}`).toString('base64'),
            },
            body: PROPFIND_RESOURCETYPE,
            signal: AbortSignal.timeout(NODE_TYPE_TIMEOUT_MS),
        });
        if (res.status !== 207) return null;
        const xml = await res.text();
        if (!/<(?:[A-Za-z0-9_-]+:)?resourcetype\b/.test(xml)) return null;
        return /<(?:[A-Za-z0-9_-]+:)?collection\s*\/>/.test(xml) ? 'folder' : 'file';
    } catch {
        return null;
    }
}

/**
 * Bee Flow trigger id for a Nextcloud event class, or null if unregistered.
 * @param {unknown} eventClass
 * @returns {string | null}
 */
function mapEvent(eventClass) {
    if (!eventClass || typeof eventClass !== 'string') return null;
    return EVENT_BY_CLASS[eventClass] || null;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
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
 * @param {unknown} rawPath
 * @returns {{ path: string | null, owner: string | null, relative: boolean }}
 */
function toUserRelativePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return { path: null, owner: null, relative: false };
    const m = /^\/?([^/]+)\/files(\/.*)?$/.exec(rawPath);
    if (!m) return { path: rawPath, owner: null, relative: false };
    return { path: m[2] || '/', owner: m[1], relative: true };
}

/**
 * The Nextcloud user who owns a calendar, from its principal URI
 * (`principals/users/<uid>`). Null for any other principal (a room, a
 * resource, the system): such a calendar has no user to check against.
 * @param {unknown} principalUri
 * @returns {string | null}
 */
function calendarOwnerOf(principalUri) {
    const m = /^principals\/users\/([^/]+)$/.exec(String(principalUri || ''));
    return m ? m[1] : null;
}

/**
 * Who a calendar is shared with, built from an allow-list: the principal URI
 * and read-only flag of each share, nothing else (#407). The server checks a
 * colleague's access to the calendar with it; display names stay behind.
 * @param {unknown} shares
 * @returns {{ principal: string, readOnly: boolean }[]}
 */
function calendarSharesOf(shares) {
    if (!Array.isArray(shares)) return [];
    /** @type {{ principal: string, readOnly: boolean }[]} */
    const out = [];
    for (const share of shares) {
        if (!share || typeof share !== 'object') continue;
        const raw = share['{http://owncloud.org/ns}principal']
            || (typeof share.href === 'string' ? share.href.replace(/^principal:/, '') : '');
        const principal = typeof raw === 'string' ? raw : '';
        if (!/^principals\/(users|groups|circles)\/[^/]+$/.test(principal)) continue;
        out.push({ principal, readOnly: share.readOnly === true });
    }
    return out;
}

/** @param {HookNode | null | undefined} node */
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

/**
 * @param {string} event  the Bee Flow trigger id
 * @param {HookEnvelope} envelope
 * @returns {HookPayload}
 */
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
        // The calendar the event lives in now (the target of a move), with its
        // owner and shares: the server decides per colleague whether they can
        // see that calendar (#407).
        const shares = e.calendarData ? e.shares : e.targetCalendarData ? e.targetShares : e.sourceShares;
        const uri = obj.uri || null;
        return {
            uid: uri ? uri.replace(/\.ics$/i, '') : null,
            objectUri: uri,
            calendarId: e.calendarId ?? e.targetCalendarId ?? e.sourceCalendarId ?? cal.id ?? null,
            calendarUri: cal.uri || null,
            calendarOwner: calendarOwnerOf(cal.principaluri),
            calendarShares: calendarSharesOf(shares),
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
            // automation than a boolean, and truthiness still reads as "is done".
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
 * trigger that gets an automation switched off.
 * @type {Map<string | number, { done: string | boolean | null, stackId: string | number | null }>}
 */
const CARD_STATE = new Map();
const CARD_STATE_MAX = 5000;

/**
 * @param {string | number | null | undefined} cardId
 * @param {{ done: string | boolean | null, stackId: string | number | null }} state
 */
function rememberCard(cardId, state) {
    if (cardId == null) return;
    // Re-insert so the Map's insertion order is a true LRU tail.
    CARD_STATE.delete(cardId);
    CARD_STATE.set(cardId, state);
    while (CARD_STATE.size > CARD_STATE_MAX) {
        const oldest = CARD_STATE.keys().next().value;
        if (oldest === undefined) break;
        CARD_STATE.delete(oldest);
    }
}

/**
 * @param {string} event
 * @param {HookPayload | null | undefined} payload  gets `previousStackId` when the card moved
 * @returns {string[]}
 */
function deckTransitions(event, payload) {
    if (!payload) return [];
    const id = payload.cardId;
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
    // without a "from" is half an event — an automation that files a card by where
    // it came from cannot work without it.
    if (prev.stackId != null) payload.previousStackId = prev.stackId;

    /** @type {string[]} */
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
    // Verify FIRST, then bill only a genuine failure — the same order the
    // /nc/* gate uses (src/ncProxy.js). The limiter is GLOBAL-keyed, so with
    // blocked() checked first a flood of forged secrets on this public route
    // 429'd the legitimate Bee Flow server too: its valid request never reached
    // succeed(), so the block stood for the whole window and Nextcloud→Bee Flow
    // event delivery stopped for every tenant on the instance. safeEqual is one
    // constant-time compare, so a valid caller is never collateral damage.
    if (!safeEqual(req.headers['x-beeflow-hook-secret'], secret)) {
        const verdict = secretLimiter.fail();
        if (!verdict.allowed) {
            res.set('Retry-After', String(Math.ceil(secretLimiter.windowMs / 1000)));
            return res.status(429).json({ error: 'Too many invalid hook secrets' });
        }
        return res.status(401).json({ error: 'Invalid hook secret' });
    }
    secretLimiter.succeed();

    /** @type {HookEnvelope} */
    const envelope = req.body || {};
    const eventClass = envelope.event?.class;
    const event = mapEvent(eventClass);
    if (!event) {
        // 200 so Nextcloud doesn't keep retrying a class we no longer handle
        // (e.g. a stale row left by an older connector version).
        return res.json({ ignored: eventClass || null });
    }

    // Read once: the loop below awaits, and a re-bootstrap may clear the key in between.
    const tenantKey = config.tenantKey;
    if (!config.ncInstanceId || !tenantKey) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    const ncUid = envelope.user?.uid || null;
    const payload = normalisePayload(event, envelope);
    if (NODE_TYPE_EVENTS.has(event)) {
        const owner = typeof payload.owner === 'string' ? payload.owner : null;
        const nodePath = typeof payload.path === 'string' ? payload.path : null;
        payload.nodeType = await nodeTypeOf(owner, nodePath);
    }

    // One Nextcloud delivery can be more than one Bee Flow event: a Deck card
    // update that also completed the card is both `changed` and `completed`.
    // Both are sent — an automation on `changed` should still fire, and the
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
        const sig = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');

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
                log.warn(`[AutomationEvents] SaaS returned ${r.status} for ${name}: ${t.slice(0, 200)}`);
            }
        } catch (err) {
            // Keep going: a failure forwarding `changed` must not swallow the
            // `completed` the author actually subscribed to.
            log.warn(`[AutomationEvents] forward failed for ${name}: ${errMessage(err)}`);
        }
    }
    // Always 200 to Nextcloud so the background job doesn't enter a retry
    // storm; SaaS failures are logged and recovered by the polling backstop.
    res.json({ ok: true, event, events });
});

module.exports = Object.assign(router, {
    mapEvent,
    normalisePayload,
    toUserRelativePath,
    calendarOwnerOf,
    calendarSharesOf,
    nodeTypeOf,
    deckTransitions,
    _resetCardState: () => CARD_STATE.clear(),
});
