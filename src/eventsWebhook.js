/**
 * NC AppAPI events_listener -> Bee Flow SaaS forwarder.
 *
 * NC fires this endpoint asynchronously when a user/group event happens.
 * The request carries an `AUTHORIZATION-APP-API` header signed with our
 * APP_SECRET, which we validate via the existing appApiAuthMiddleware.
 *
 * We translate NC's event payload into a stable shape, sign it with the
 * tenant key, and POST to the SaaS at /auth/webhook/nc-user-sync. The
 * SaaS verifies the signature against `connector_tenant_key_<orgId>` and
 * applies the change in server/services/ncUserGroupSync.js.
 *
 * The connector is the trust boundary: NC -> connector is signed with
 * APP_SECRET (already enforced upstream), connector -> SaaS is signed
 * with the tenant key. Neither secret leaves its side.
 */

const express = require('express');
const crypto = require('crypto');
const config = require('./config');

// NC's event payload uses class names like OCP\User\Events\UserCreatedEvent.
// Map them to the simplified events ncUserGroupSync.js understands.
function mapEvent(eventType) {
    if (!eventType) return null;
    if (eventType.endsWith('UserCreatedEvent')) return 'user.created';
    if (eventType.endsWith('UserDeletedEvent')) return 'user.deleted';
    if (eventType.endsWith('UserChangedEvent')) return 'user.updated';
    if (eventType.endsWith('UserAddedEvent')) return 'group.member_added';
    if (eventType.endsWith('UserRemovedEvent')) return 'group.member_removed';
    return null;
}

// Pull the affected uid out of the event payload. NC's events carry the
// user object differently per event class, so be tolerant.
function extractUid(payload) {
    return payload?.userId
        || payload?.uid
        || payload?.user?.UID
        || payload?.user?.uid
        || payload?.event?.userId
        || null;
}

function extractGroupId(payload) {
    return payload?.groupId || payload?.group?.gid || null;
}

const router = express.Router();

router.post('/webhook/nc-events', express.json({ limit: '256kb' }), async (req, res) => {
    const eventType = req.body?.eventType || req.body?.event;
    const event = mapEvent(eventType);
    if (!event) return res.json({ ignored: eventType });
    const ncUid = extractUid(req.body);
    const groupId = extractGroupId(req.body);
    if (!ncUid) return res.status(400).json({ error: 'No uid in payload' });

    if (!config.tenantKey || !config.ncInstanceId) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    const body = JSON.stringify({ event, ncUid, groupId });
    const ts = Math.floor(Date.now() / 1000);
    const path = '/auth/webhook/nc-user-sync';
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
            console.warn(`[EventsWebhook] SaaS returned ${r.status}: ${t.slice(0, 200)}`);
        }
    } catch (err) {
        console.warn(`[EventsWebhook] forward failed: ${err.message}`);
    }
    res.json({ ok: true, event, ncUid });
});

module.exports = router;
