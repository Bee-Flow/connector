/**
 * Nextcloud Talk bot — the only way to get chat events out of Nextcloud.
 *
 * Talk exposes no webhook-compatible event class, so `webhook_listeners`
 * cannot deliver chat messages (see webhookListeners.js). Bots are the
 * supported mechanism, and they are a better fit anyway: a bot is added to
 * specific conversations by their moderators, so a routine reacting to chat
 * only ever sees rooms someone deliberately invited Bee Flow into. There is no
 * "listen to every conversation on the instance" mode, by design.
 *
 * Registration goes through AppAPI (`/apps/app_api/api/v1/talk_bot`), which
 * mints the shared secret and hands it back in the OCS response — we never
 * choose it. Talk then signs every delivery with it, and it is the same secret
 * a bot uses to post. It must therefore survive container restarts, so it is
 * persisted alongside the tenant-key cache in APP_PERSISTENT_STORAGE.
 *
 * Signature scheme (nextcloud/spreed docs/bots.md):
 *   HMAC-SHA256(X-Nextcloud-Talk-Random + rawBody, secret) == X-Nextcloud-Talk-Signature
 * Note that it is the *raw* body, so this route must not be body-parsed before
 * the check — see server.js, where the JSON parser is scoped away from it.
 *
 * Payloads are Activity Streams 2.0:
 *   type "Create" + object.name "message"  → a chat message
 *   type "Like"   / "Undo"                 → a reaction added / removed
 *   type "Join"   / "Leave"                → the bot was added to / removed
 *                                            from a conversation
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const TALK_BOT_API = '/ocs/v2.php/apps/app_api/api/v1/talk_bot';
// Declared PUBLIC in appinfo/info.xml: Talk calls it with no user session and
// authenticates with its own signature instead.
const BOT_ROUTE = '/hooks/talk';
const SECRET_FILE = 'talk-bot.json';

const BOT_NAME = 'Bee Flow';
const BOT_DESCRIPTION = 'Runs Bee Flow routines from this conversation. Add the bot to a conversation to let automations react to what is said in it.';

let _secret = null;

function secretPath() {
    return path.join(config.persistentStorage, SECRET_FILE);
}

function loadSecret() {
    if (_secret) return _secret;
    try {
        const raw = JSON.parse(fs.readFileSync(secretPath(), 'utf8'));
        if (raw && typeof raw.secret === 'string' && raw.secret) _secret = raw.secret;
    } catch (_) { /* not registered yet, or unreadable — treated as absent */ }
    return _secret;
}

function saveSecret(secret) {
    _secret = secret;
    try {
        fs.mkdirSync(config.persistentStorage, { recursive: true });
        fs.writeFileSync(secretPath(), JSON.stringify({ secret, savedAt: Date.now() }), { mode: 0o600 });
    } catch (err) {
        // Non-fatal: the bot works until the container restarts, at which point
        // re-registration mints a fresh secret anyway.
        console.warn(`[TalkBot] could not persist the bot secret: ${err.message}`);
    }
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

/**
 * Register the bot with Talk (via AppAPI) and keep the secret it returns.
 * Idempotent: re-registering the same (appId, route) reuses the existing
 * secret upstream rather than minting a new one.
 */
async function registerTalkBot() {
    const url = `${config.nextcloudUrl}${TALK_BOT_API}`;
    let res;
    try {
        res = await withWarmupRetry(() => fetch(url, {
            method: 'POST',
            headers: appApiHeaders(),
            body: JSON.stringify({ name: BOT_NAME, route: BOT_ROUTE, description: BOT_DESCRIPTION }),
            signal: AbortSignal.timeout(5_000),
        }), { label: 'talk-bot', budgetMs: 30_000 });
    } catch (err) {
        console.warn(`[TalkBot] registration request failed: ${err.message}`);
        return { ok: false, reason: 'request-failed' };
    }

    if (res.status === 404 || res.status === 501) {
        // Talk not installed. Perfectly normal — chat triggers are simply
        // unavailable on this instance.
        console.log('[TalkBot] Talk is not installed on this Nextcloud — chat triggers unavailable.');
        return { ok: false, reason: 'talk-missing' };
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[TalkBot] registration failed (HTTP ${res.status}): ${body.slice(0, 160)}`);
        return { ok: false, reason: `http-${res.status}` };
    }

    const body = await res.json().catch(() => null);
    const secret = body?.ocs?.data?.secret;
    if (!secret) {
        // Without the secret we cannot verify a single delivery, so treat this
        // as a failure rather than reporting a bot that can never be trusted.
        console.warn('[TalkBot] Nextcloud did not return a bot secret — chat triggers will not work.');
        return { ok: false, reason: 'no-secret' };
    }
    saveSecret(secret);
    console.log('[TalkBot] registered — add "Bee Flow" to a conversation to enable chat triggers there.');
    return { ok: true };
}

async function unregisterTalkBot() {
    if (!config.nextcloudUrl) return;
    await fetch(`${config.nextcloudUrl}${TALK_BOT_API}`, {
        method: 'DELETE',
        headers: appApiHeaders(),
        body: JSON.stringify({ route: BOT_ROUTE }),
        signal: AbortSignal.timeout(2_000),
    }).catch(() => {});
}

/**
 * Verify a delivery. Constant-time, and fails closed when we have no secret
 * (which is the state after a persistent-storage wipe until re-registration).
 */
function verifyTalkSignature(req) {
    const secret = loadSecret();
    if (!secret) return false;
    const random = req.headers['x-nextcloud-talk-random'];
    const signature = req.headers['x-nextcloud-talk-signature'];
    if (typeof random !== 'string' || typeof signature !== 'string') return false;
    // Talk documents the random as 64 chars; reject anything short enough to
    // be brute-forceable rather than trusting the header blindly.
    if (random.length < 32) return false;

    const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
    const expected = crypto.createHmac('sha256', secret).update(random + raw).digest();
    const got = Buffer.from(String(signature).toLowerCase(), 'hex');
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, got);
}

/**
 * Activity Streams envelope → Bee Flow trigger. Returns null for anything we
 * don't turn into a trigger (joins, leaves, system messages).
 */
function mapActivity(body) {
    if (!body || typeof body !== 'object') return null;
    const token = body.target?.id || body.object?.id || null;
    const roomName = body.target?.name || body.object?.name || null;
    // actor.id is "<type>/<id>", e.g. "users/ada-lovelace".
    const actorRaw = String(body.actor?.id || '');
    const actor = actorRaw.includes('/') ? actorRaw.slice(actorRaw.indexOf('/') + 1) : (actorRaw || null);

    if (body.type === 'Create' && body.object?.name === 'message') {
        // object.content is a JSON string with {message, parameters}; the
        // rendered mentions live in parameters, so the raw message keeps
        // placeholders like {mention-call1}. Callers get both.
        let message = '';
        let parameters = null;
        try {
            const parsed = JSON.parse(body.object.content || '{}');
            message = typeof parsed.message === 'string' ? parsed.message : '';
            parameters = parsed.parameters || null;
        } catch (_) { message = String(body.object.content || ''); }
        return {
            event: 'talk.message.received',
            payload: {
                messageId: body.object.id ?? null,
                roomToken: token,
                roomName,
                actor,
                actorName: body.actor?.name || null,
                message,
                parameters,
                isMarkdown: body.object.mediaType === 'text/markdown',
                inReplyTo: body.object.inReplyTo?.object?.id ?? null,
                datetime: new Date().toISOString(),
            },
        };
    }

    if (body.type === 'Like' || body.type === 'Undo') {
        // A reaction. `object` is the message that was reacted to; `content`
        // carries the emoji. This is what makes approve/reject-by-emoji
        // possible without parsing free text.
        return {
            event: 'talk.reaction.added',
            payload: {
                messageId: body.object?.id ?? null,
                roomToken: token,
                roomName,
                actor,
                actorName: body.actor?.name || null,
                reaction: body.content || '',
                removed: body.type === 'Undo',
                datetime: new Date().toISOString(),
            },
        };
    }

    return null;
}

const router = express.Router();

// express.raw, not express.json: the signature covers the exact bytes Talk
// sent, so the body must be captured verbatim before anything reshapes it.
router.post(BOT_ROUTE, express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyTalkSignature(req)) {
        return res.status(401).json({ error: 'Invalid Talk bot signature' });
    }

    let body;
    try { body = JSON.parse(req.rawBody || '{}'); } catch (_) { body = null; }
    const mapped = mapActivity(body);
    if (!mapped) {
        // Joins, leaves and system messages land here. 200 so Talk does not
        // treat the bot as unhealthy.
        return res.json({ ignored: body?.type || null });
    }

    if (!config.tenantKey || !config.ncInstanceId) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    const payloadBody = JSON.stringify({
        event: mapped.event,
        ncUid: mapped.payload.actor,
        payload: mapped.payload,
    });
    const ts = Math.floor(Date.now() / 1000);
    const apiPath = '/api/automation/events/nextcloud';
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nPOST\n${apiPath}\n${payloadBody}`).digest('hex');

    try {
        const r = await fetch(`${config.apiBaseUrl}${apiPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Beeflow-Source': 'nextcloud-connector',
                'X-Beeflow-NC-Instance-Id': config.ncInstanceId,
                'X-Beeflow-Sig': `${ts}.${sig}`,
            },
            body: payloadBody,
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.warn(`[TalkBot] SaaS returned ${r.status}: ${t.slice(0, 200)}`);
        }
    } catch (err) {
        console.warn(`[TalkBot] forward failed: ${err.message}`);
    }
    res.json({ ok: true, event: mapped.event });
});

module.exports = router;
module.exports.registerTalkBot = registerTalkBot;
module.exports.unregisterTalkBot = unregisterTalkBot;
module.exports.verifyTalkSignature = verifyTalkSignature;
module.exports.mapActivity = mapActivity;
module.exports.loadSecret = loadSecret;
module.exports.saveSecret = saveSecret;
module.exports.BOT_ROUTE = BOT_ROUTE;
