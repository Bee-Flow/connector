/**
 * NC AppAPI events_listener -> Bee Flow Automations forwarder.
 *
 * Parallels eventsWebhook.js but targets the Automations engine instead of
 * user/group sync. NC fires this endpoint asynchronously when a Files /
 * Sharing / Calendar / Deck / Talk / Comment / Tag event happens.
 *
 * The connector translates the raw NC event class into our trigger
 * taxonomy (e.g. NodeCreatedEvent → file.new, CardUpdatedEvent →
 * deck.card.changed), normalises the payload to the same shape our
 * builder advertises, signs the body with the tenant key, and POSTs to
 * the SaaS at /api/automation/events/nextcloud.
 *
 * Auth boundary: NC -> connector is signed with APP_SECRET (validated by
 * the upstream appApiAuthMiddleware). Connector -> SaaS is signed with
 * the tenant key. Neither secret leaves its trust zone.
 */

const express = require('express');
const crypto = require('crypto');
const config = require('./config');

// NC's event payload uses fully-qualified class names like
// OCP\Files\Events\Node\NodeCreatedEvent. Map each to our stable trigger
// type. Returning null skips the event (we ignore unknown classes
// silently — the registration list and this map are kept in sync, but a
// future NC release can deliver a class we haven't taught the connector
// about yet).
function mapEvent(eventType) {
    if (!eventType) return null;
    // Files
    if (eventType.endsWith('NodeCreatedEvent')) return 'file.new';
    if (eventType.endsWith('NodeWrittenEvent')) return 'file.changed';
    if (eventType.endsWith('NodeDeletedEvent')) return 'file.deleted';
    if (eventType.endsWith('NodeRenamedEvent')) return 'file.renamed';
    // Shares
    if (eventType.endsWith('ShareCreatedEvent')) return 'share.created';
    if (eventType.endsWith('ShareAcceptedEvent')) return 'share.received';
    if (eventType.endsWith('ShareDeletedEvent')) return 'share.deleted';
    // Comments + tags
    if (eventType.endsWith('CommentsEvent')) return 'file.commented';
    if (eventType.endsWith('SystemTag\\ManagerEvent') || eventType.endsWith('ManagerEvent')) return 'file.tagged';
    // Calendar
    if (eventType.endsWith('CalendarObjectCreatedEvent')) return 'calendar.event.created';
    if (eventType.endsWith('CalendarObjectUpdatedEvent')) return 'calendar.event.changed';
    if (eventType.endsWith('CalendarObjectDeletedEvent')) return 'calendar.event.deleted';
    // Deck
    if (eventType.endsWith('CardCreatedEvent')) return 'deck.card.created';
    if (eventType.endsWith('CardUpdatedEvent')) return 'deck.card.changed';
    if (eventType.endsWith('CardDeletedEvent')) return 'deck.card.deleted';
    // Talk
    if (eventType.endsWith('ChatMessageSentEvent')) return 'talk.message.received';
    return null;
}

// mapEvent only sees the class name, but some classes are coarser than our
// trigger taxonomy. This second pass inspects the payload to refine a generic
// Deck CardUpdatedEvent ('deck.card.changed') into the higher-level events the
// templates subscribe to. Best-effort: a single NC event may not carry prior
// state, so 'moved' only fires when both the old and new stack id are present;
// 'completed' is keyed off the archived flag (the common "done" signal).
function refineEvent(event, raw) {
    if (event === 'deck.card.changed') {
        const card = raw?.card || raw?.cardData || {};
        const archived = !!(card.archived ?? raw?.archived);
        if (archived) return 'deck.card.completed';
        const from = raw?.fromStackId ?? raw?.oldStackId ?? null;
        const to = card.stackId ?? raw?.toStackId ?? raw?.stackId ?? null;
        if (from != null && to != null && String(from) !== String(to)) return 'deck.card.moved';
    }
    return event;
}

// Best-effort actor extraction. Different NC event classes hand the user
// id back in different shapes; tolerant parser keeps the wiring simple.
function extractActor(payload) {
    return payload?.actor
        || payload?.userId
        || payload?.uid
        || payload?.user?.UID
        || payload?.user?.uid
        || payload?.event?.userId
        || null;
}

// Best-effort path / name extraction for file-shaped events.
function extractFileFields(payload) {
    const node = payload?.node || payload?.target || payload?.file || {};
    const path = node.path || payload?.path || null;
    const name = node.name || payload?.name || (path ? path.split('/').filter(Boolean).pop() : null);
    const id = node.id || payload?.fileId || node.fileId || null;
    const ext = name && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : null;
    const isFolder = node.type === 'folder' || node.mimeType === 'httpd/unix-directory';
    return { id, path, name, extension: ext, kind: isFolder ? 'folder' : 'file' };
}

function normalisePayload(event, raw) {
    const actor = extractActor(raw);
    const datetime = raw?.datetime || raw?.timestamp || new Date().toISOString();
    if (event.startsWith('file.')) {
        const f = extractFileFields(raw);
        return { ...f, actor, datetime, link: raw?.link || null };
    }
    if (event.startsWith('share.')) {
        const f = extractFileFields(raw);
        const share = raw?.share || raw?.shareData || raw || {};
        const stRaw = share.shareType ?? share.share_type ?? raw?.shareType ?? null;
        // NC share_type ints → the string the matcher (matchNextcloudShareGenericFilter)
        // and the UI filter both use.
        const ST = { 0: 'user', 1: 'group', 2: 'usergroup', 3: 'link', 4: 'email', 6: 'federated', 7: 'federated_group', 9: 'circle', 10: 'room', 11: 'deck', 12: 'sciencemesh' };
        const shareType = typeof stRaw === 'number' ? (ST[stRaw] || String(stRaw)) : (stRaw || null);
        return {
            ...f,
            shareId: share.id ?? raw?.shareId ?? raw?.id ?? null,
            shareType,
            actor, datetime,
            link: raw?.link || share.token || null,
        };
    }
    if (event.startsWith('calendar.')) {
        const e = raw?.event || raw?.calendarObject || {};
        return {
            uid: e.uid || raw?.uid || null,
            calendarId: e.calendarId || raw?.calendarId || null,
            summary: e.summary || raw?.summary || '',
            startsAt: e.start || raw?.start || null,
            endsAt: e.end || raw?.end || null,
            actor, datetime,
        };
    }
    if (event.startsWith('deck.')) {
        const card = raw?.card || raw?.cardData || {};
        return {
            cardId: card.id || raw?.cardId || null,
            boardId: card.boardId || raw?.boardId || null,
            stackId: card.stackId || raw?.stackId || null,
            fromStackId: raw?.fromStackId ?? raw?.oldStackId ?? null,
            toStackId: card.stackId ?? raw?.toStackId ?? raw?.stackId ?? null,
            title: card.title || raw?.title || '',
            archived: !!(card.archived ?? raw?.archived),
            actor, datetime,
        };
    }
    if (event.startsWith('talk.')) {
        return {
            messageId: raw?.id || raw?.messageId || null,
            roomToken: raw?.token || raw?.roomToken || null,
            roomName: raw?.roomName || null,
            actor: raw?.actorId || actor,
            message: raw?.message || raw?.body || '',
            datetime,
        };
    }
    return { ...raw, actor, datetime };
}

const router = express.Router();

router.post('/webhook/automation', express.json({ limit: '512kb' }), async (req, res) => {
    const eventType = req.body?.eventType || req.body?.event;
    const event = refineEvent(mapEvent(eventType), req.body);
    if (!event) {
        // Still 200 so NC doesn't keep retrying classes we don't care about.
        return res.json({ ignored: eventType });
    }

    if (!config.tenantKey || !config.ncInstanceId) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    const ncUid = extractActor(req.body);
    const payload = normalisePayload(event, req.body);

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
    // Always 200 to NC so the listener doesn't enter retry storms; SaaS
    // failures are logged and recovered by the polling backstop.
    res.json({ ok: true, event });
});

module.exports = router;
