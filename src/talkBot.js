/**
 * Nextcloud Talk bot — the only way to get chat events out of Nextcloud.
 *
 * Talk exposes no webhook-compatible event class, so `webhook_listeners`
 * cannot deliver chat messages (see webhookListeners.js). Bots are the
 * supported mechanism, and they are a better fit anyway: a bot is added to
 * specific conversations by their moderators, so an automation reacting to chat
 * only ever sees rooms someone deliberately invited Bee Flow into. There is no
 * "listen to every conversation on the instance" mode, by design.
 *
 * Registration goes through AppAPI (`/apps/app_api/api/v1/talk_bot`), which
 * mints the shared secret and hands it back in the OCS response — we never
 * choose it. That secret is used for the OUTBOUND direction: signing bot
 * messages we post back (X-Nextcloud-Talk-Bot-Signature, see _sendBotMessage).
 * It must survive container restarts, so it is persisted alongside the
 * tenant-key cache in APP_PERSISTENT_STORAGE.
 *
 * INBOUND auth — this is the subtle part. Because the bot is registered THROUGH
 * AppAPI, Nextcloud does not POST deliveries straight to this route. Talk POSTs
 * them to AppAPI's own proxy route, AppAPI verifies the Talk HMAC itself
 * (X-Nextcloud-Talk-Signature over X-Nextcloud-Talk-Random + raw body), and only
 * then forwards to this ExApp via requestToExApp with a NULL userId. The
 * forwarded request therefore carries the ordinary AppAPI headers —
 * `AUTHORIZATION-APP-API: base64(":"+APP_SECRET)` + EX-APP-ID — and a re-encoded
 * JSON body; the X-Nextcloud-Talk-* headers are gone. So we authenticate the
 * shared secret here (exactly like the /trigger and /files-action service
 * calls), NOT a Talk signature — verifying a Talk signature on this route 401s
 * every real delivery, which is why the bot's @mention/reaction features were
 * silently dead before this. (This route is mounted before the AppAPI gate in
 * server.js because AppAPI's forward carries an empty userId, which that gate
 * rejects; the secret check below is the equivalent boundary.)
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
const { withWarmupRetry, appApiHeaders } = require('./appApiClient');
const { secretMatches, decodeAuthHeader } = require('./auth');
const rateLimit = require('./rateLimit');
const log = require('./log');
const { errMessage } = require('./errors');

// Brute-force gate on the inbound AppAPI shared-secret check. AppAPI itself
// never presents a bad one, so only failures are billed and real deliveries are
// never throttled. Verified BEFORE it can block, so a flood of forged requests
// (this route is PUBLIC) can never lock out a legitimate delivery.
const sigLimiter = rateLimit.penalise('talk-bot-auth', { limit: 60, windowMs: 60_000 });

const TALK_BOT_API = '/ocs/v2.php/apps/app_api/api/v1/talk_bot';
// Declared PUBLIC in appinfo/info.xml: Talk calls it with no user session and
// authenticates with its own signature instead.
const BOT_ROUTE = '/hooks/talk';
const SECRET_FILE = 'talk-bot.json';

const BOT_NAME = 'Bee Flow';
const BOT_DESCRIPTION = 'Runs Bee Flow automations from this conversation. Add the bot to a conversation to let automations react to what is said in it.';

/** @type {string | null} */
let _secret = null;

/** @returns {string} */
function secretPath() {
    return path.join(config.persistentStorage, SECRET_FILE);
}

/** @returns {string | null} */
function loadSecret() {
    if (_secret) return _secret;
    try {
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- reads the bot secret from its file at runtime; nothing is hardcoded
        const raw = /** @type {{ secret?: unknown } | null} */ (JSON.parse(fs.readFileSync(secretPath(), 'utf8')));
        if (raw && typeof raw.secret === 'string' && raw.secret) _secret = raw.secret;
    } catch (_) { /* not registered yet, or unreadable — treated as absent */ }
    return _secret;
}

/** @param {string} secret */
function saveSecret(secret) {
    _secret = secret;
    try {
        fs.mkdirSync(config.persistentStorage, { recursive: true });
        fs.writeFileSync(secretPath(), JSON.stringify({ secret, savedAt: Date.now() }), { mode: 0o600 });
    } catch (err) {
        // Non-fatal: the bot works until the container restarts, at which point
        // re-registration mints a fresh secret anyway.
        log.warn(`[TalkBot] could not persist the bot secret: ${errMessage(err)}`);
    }
}

/** @returns {Promise<Response>} */
function postRegistration() {
    return withWarmupRetry(() => fetch(`${config.nextcloudUrl}${TALK_BOT_API}`, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ name: BOT_NAME, route: BOT_ROUTE, description: BOT_DESCRIPTION }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'talk-bot', budgetMs: 30_000 });
}

/**
 * Register the bot with Talk (via AppAPI) and keep the secret it returns.
 *
 * NOT idempotent upstream: AppAPI mints a new secret on every registration,
 * and Talk refuses a bot whose URL is already registered with another secret
 * (an OCS 500, "Bot with the same URL and a different secret is already
 * registered"; the cause is only in Nextcloud's log). So on every start after
 * the first, the POST fails (#281):
 *   - with a stored secret, that is the bot Talk already has: keep it. Deleting
 *     it to re-register would also drop the bot from every conversation it was
 *     added to (the same reason a container stop no longer unregisters it,
 *     see shutdown.js).
 *   - without one (fresh volume), the registered bot is unusable to us (no
 *     secret to verify deliveries or sign replies with): remove it and
 *     register again.
 */
async function registerTalkBot() {
    /** @type {Response} */
    let res;
    try {
        res = await postRegistration();
    } catch (err) {
        log.warn(`[TalkBot] registration request failed: ${errMessage(err)}`);
        return { ok: false, reason: 'request-failed' };
    }

    if (res.status === 404 || res.status === 501) {
        // Talk not installed. Perfectly normal — chat triggers are simply
        // unavailable on this instance.
        log.info('[TalkBot] Talk is not installed on this Nextcloud — chat triggers unavailable.');
        return { ok: false, reason: 'talk-missing' };
    }
    if (!res.ok && loadSecret()) {
        log.info(`[TalkBot] already registered (Nextcloud answered HTTP ${res.status} to a re-registration); keeping the stored secret.`);
        return { ok: true, reason: 'kept-existing' };
    }
    if (!res.ok) {
        log.info(`[TalkBot] registration refused (HTTP ${res.status}) and no stored secret: removing the existing bot and registering again. Conversations that had the bot must add it again.`);
        await unregisterTalkBot();
        try {
            res = await postRegistration();
        } catch (err) {
            log.warn(`[TalkBot] registration request failed: ${errMessage(err)}`);
            return { ok: false, reason: 'request-failed' };
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log.warn(`[TalkBot] registration failed (HTTP ${res.status}): ${body.slice(0, 160)}`);
            return { ok: false, reason: `http-${res.status}` };
        }
    }

    const body = /** @type {{ ocs?: { data?: { secret?: string } } } | null} */ (await res.json().catch(() => null));
    const secret = body?.ocs?.data?.secret;
    if (!secret) {
        // Without the secret we cannot verify a single delivery, so treat this
        // as a failure rather than reporting a bot that can never be trusted.
        log.warn('[TalkBot] Nextcloud did not return a bot secret — chat triggers will not work.');
        return { ok: false, reason: 'no-secret' };
    }
    saveSecret(secret);
    log.info('[TalkBot] registered — add "Bee Flow" to a conversation to enable chat triggers there.');
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
 * Verify an inbound delivery forwarded by AppAPI. The forwarded request is
 * authenticated by the AppAPI shared secret (base64(userId:APP_SECRET), with an
 * empty userId for this service-level forward) — the same boundary auth.js
 * enforces for browser traffic. Constant-time via secretMatches; EX-APP-ID is
 * checked when present. Returns false on a missing/mismatched secret.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function verifyInboundAppApi(req) {
    const decoded = decodeAuthHeader(req.headers['authorization-app-api']);
    if (!decoded || !secretMatches(decoded.secret)) return false;
    const appId = req.headers['ex-app-id'];
    if (appId && appId !== config.appId) return false;
    return true;
}

/**
 * Activity Streams envelope → Bee Flow trigger. Returns null for anything we
 * don't turn into a trigger (joins, leaves, system messages).
 *
 * @typedef {object} ActivityObject
 * @property {string | number} [id]
 * @property {string} [name]
 * @property {string} [content]
 * @property {string} [mediaType]
 * @property {{ object?: { id?: string | number } }} [inReplyTo]
 * @property {ActivityObject} [object]  the reacted-to message, inside an `Undo`
 *
 * @typedef {object} TalkActivity  an Activity Streams 2.0 envelope as Talk sends it
 * @property {string} [type]
 * @property {{ id?: string, name?: string }} [actor]
 * @property {{ id?: string, name?: string }} [target]
 * @property {ActivityObject} [object]
 * @property {string} [content]
 *
 * @typedef {object} TalkMessagePayload
 * @property {string | number | null} messageId
 * @property {string | number | null} roomToken
 * @property {string | null} roomName
 * @property {string | null} actor
 * @property {string | null} actorType
 * @property {string | null} actorName
 * @property {string} message
 * @property {Record<string, unknown> | null} parameters  mention placeholders by key
 * @property {boolean} isMarkdown
 * @property {string | number | null} inReplyTo
 * @property {string} datetime
 *
 * @typedef {object} TalkReactionPayload
 * @property {string | number | null} messageId
 * @property {string | number | null} roomToken
 * @property {string | null} roomName
 * @property {string | null} actor
 * @property {string | null} actorType
 * @property {string | null} actorName
 * @property {string} reaction
 * @property {boolean} removed
 * @property {string} datetime
 *
 * @typedef {{ event: 'talk.message.received', payload: TalkMessagePayload }
 *   | { event: 'talk.reaction.added', payload: TalkReactionPayload }} MappedActivity
 *
 * @param {TalkActivity | null | undefined} body
 * @returns {MappedActivity | null}
 */
function mapActivity(body) {
    if (!body || typeof body !== 'object') return null;
    const token = body.target?.id || body.object?.id || null;
    const roomName = body.target?.name || body.object?.name || null;
    // actor.id is "<type>/<id>", e.g. "users/ada-lovelace" or "bots/42".
    const actorRaw = String(body.actor?.id || '');
    const slash = actorRaw.indexOf('/');
    const actorType = slash > 0 ? actorRaw.slice(0, slash) : null;
    const actor = slash >= 0 ? actorRaw.slice(slash + 1) : (actorRaw || null);

    if (body.type === 'Create' && body.object?.name === 'message') {
        // object.content is a JSON string with {message, parameters}; the
        // rendered mentions live in parameters, so the raw message keeps
        // placeholders like {mention-call1}. Callers get both.
        let message = '';
        /** @type {Record<string, unknown> | null} */
        let parameters = null;
        try {
            const parsed = /** @type {{ message?: unknown, parameters?: Record<string, unknown> | null }} */ (JSON.parse(body.object.content || '{}'));
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
                actorType,
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
        // A reaction. This is what makes approve/reject-by-emoji possible
        // without parsing free text.
        //
        // The two envelopes are NOT the same shape (spreed docs/bots.md):
        //   Like → object IS the message, top-level content IS the emoji
        //   Undo → object is the whole original Like, so the message is one
        //          level deeper and the emoji is object.content
        // Reading the Like shape for both is why a removal used to arrive with
        // a null messageId and an empty reaction.
        const removed = body.type === 'Undo';
        const reacted = removed ? body.object?.object : body.object;
        const emoji = removed ? body.object?.content : body.content;
        return {
            event: 'talk.reaction.added',
            payload: {
                messageId: reacted?.id ?? null,
                roomToken: token,
                roomName,
                actor,
                // Which KIND of attendee reacted ('users' | 'guests' | 'bots').
                // A vote may only ever come from a real user, and the bot's
                // own seeded 👍 must be distinguishable from a person's.
                actorType,
                actorName: body.actor?.name || null,
                reaction: emoji || '',
                removed,
                datetime: new Date().toISOString(),
            },
        };
    }

    return null;
}

// ── @mention → agent answer ─────────────────────────────────────────────────
//
// The bot forwards every message to the SaaS automations engine (below). ON TOP of
// that, when a HUMAN @mentions "Bee Flow" in a conversation the bot is in, we
// answer inline: strip the mention, run the Nextcloud agent task type (read-only
// tools scoped to the mentioning user, the same provider the Assistant uses),
// and post the reply back through Talk's bot API. This is the "@ in Talk"
// experience — no automation to build.
//
// Fire-and-forget by design: an agent turn can take many seconds, and Talk needs
// a prompt 200 on the webhook or it marks the bot unhealthy. So the webhook
// answers immediately and the reply is posted out-of-band.

const AGENT_TASK_TYPE = 'core:contextagent:interaction';

// Does this message @mention the bot? Talk's structured mention parameters are
// the accurate "@" signal. Only a message that carries NO mention at all falls
// back to the text, and then only to a literal "@Bee Flow": "the Bee Flow
// report is late" used to start an agent run as that user and post the answer
// to the room.
/** @param {{ parameters?: Record<string, unknown> | null, message?: string } | null | undefined} payload */
function mentionsBot(payload) {
    const params = payload?.parameters;
    const mentions = params && typeof params === 'object' ? Object.values(params) : [];
    if (mentions.length) {
        return mentions.some(v => v && typeof v === 'object' && 'name' in v
            && String(v.name || '').toLowerCase() === BOT_NAME.toLowerCase());
    }
    return /(^|\s)@bee\s*flow\b/i.test(String(payload?.message || ''));
}

// Recover the question from a mention message: drop Talk's {mention-…}
// placeholders and a literal "@Bee Flow", collapse whitespace.
/** @param {{ message?: string } | null | undefined} payload */
function extractQuestion(payload) {
    return String(payload?.message || '')
        .replace(/\{mention-[^}]*\}/g, ' ')
        .replace(/@?\bbee\s*flow\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Ask the SaaS agent, reusing the same signed execute endpoint the Task
// Processing providers use. Returns the answer text (possibly empty).
/**
 * @param {{ question: string, ncUid: string | null, roomToken: string | number }} args
 * @returns {Promise<string>}
 */
async function askSaaSAgent({ question, ncUid, roomToken }) {
    if (!config.tenantKey || !config.ncInstanceId) throw new Error('connector not yet bootstrapped');
    const apiPath = '/api/nextcloud/task-processing/execute';
    const body = JSON.stringify({
        taskType: AGENT_TASK_TYPE,
        // conversation_token keys the agent's per-thread memory; one thread per
        // room so a follow-up mention continues the same conversation.
        input: { input: question, conversation_token: `talk:${roomToken}` },
        ncUid: ncUid || null,
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nPOST\n${apiPath}\n${body}`).digest('hex');
    const res = await fetch(`${config.apiBaseUrl}${apiPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': config.ncInstanceId,
            'X-Beeflow-Sig': `${ts}.${sig}`,
        },
        body,
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
        throw new Error(`SaaS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = /** @type {{ output?: string | { output?: string } } | null} */ (await res.json().catch(() => null));
    const out = data?.output;
    if (out && typeof out === 'object') return String(out.output || '').trim();
    return typeof out === 'string' ? out.trim() : '';
}

// Post a message back to a conversation as the bot. Auth is the bot signature
// over RANDOM + message (spreed docs/bots.md), NOT a user session.
/**
 * @param {string | number} token
 * @param {string} msg
 * @param {string | number | null | undefined} replyTo
 */
async function _sendBotMessage(token, msg, replyTo) {
    const secret = loadSecret();
    if (!secret) throw new Error('no bot secret — cannot post');
    // The signature covers RANDOM + the message content only (spreed
    // docs/bots.md), NOT the JSON envelope, so replyTo/referenceId are outside it.
    const random = crypto.randomBytes(32).toString('hex');
    const signature = crypto.createHmac('sha256', secret).update(random + msg).digest('hex');
    const referenceId = crypto.createHash('sha256').update(`${random}:${msg}`).digest('hex');
    const url = `${config.nextcloudUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(token)}/message`;
    /** @type {{ message: string, referenceId: string, replyTo?: number }} */
    const bodyObj = { message: msg, referenceId };
    if (Number.isFinite(Number(replyTo)) && Number(replyTo) > 0) bodyObj.replyTo = Number(replyTo);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'OCS-APIRequest': 'true',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Nextcloud-Talk-Bot-Random': random,
            'X-Nextcloud-Talk-Bot-Signature': signature,
        },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(10_000),
    });
    return res;
}

/**
 * @param {string | number} token
 * @param {unknown} message
 * @param {string | number | null | undefined} [replyTo]
 */
async function postBotMessage(token, message, replyTo) {
    const msg = String(message || '').slice(0, 32000);
    if (!msg) return;
    let res = await _sendBotMessage(token, msg, replyTo);
    // A stale/invalid replyTo (deleted message, or one the bot can't see) makes
    // Talk 400 the whole post. The answer matters more than the threading, so
    // drop replyTo and try once more before giving up.
    if (!res.ok && replyTo != null && res.status === 400) {
        res = await _sendBotMessage(token, msg, null);
    }
    if (!res.ok) {
        throw new Error(`bot message HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
}

/** @param {TalkMessagePayload} payload */
async function handleMention(payload) {
    const roomToken = payload?.roomToken;
    if (!roomToken) return;
    const question = extractQuestion(payload);
    if (!question) {
        await postBotMessage(roomToken,
            'Hi! Mention me with a question — e.g. "@Bee Flow what changed in my calendar today?"',
            payload.messageId).catch(e => log.warn(`[TalkBot] reply failed: ${errMessage(e)}`));
        return;
    }
    try {
        const answer = await askSaaSAgent({ question, ncUid: payload.actor, roomToken });
        await postBotMessage(roomToken, answer || 'I could not find an answer to that.', payload.messageId);
        log.info(`[TalkBot] answered @mention in room ${roomToken} (uid=${log.ref(payload.actor)})`);
    } catch (err) {
        log.warn(`[TalkBot] @mention answer failed for room ${roomToken}: ${errMessage(err)}`);
        await postBotMessage(roomToken,
            'Sorry — I could not answer that just now. Please try again in a moment.',
            payload.messageId).catch(() => {});
    }
}

const router = express.Router();

// express.json: AppAPI forwards the delivery as a normal JSON body (it re-encodes
// the request params), so there is no raw-body HMAC to preserve any more — the
// inbound auth is the AppAPI shared secret, checked below.
router.post(BOT_ROUTE, express.json({ type: () => true, limit: '256kb' }), async (req, res) => {
    // Verify the shared secret FIRST, then bill only genuine failures — a valid
    // delivery must never be locked out by a flood of forged ones on this PUBLIC
    // route (see rateLimit.js and the ncProxy verify-first gate).
    if (!verifyInboundAppApi(req)) {
        const verdict = sigLimiter.fail();
        if (!verdict.allowed) {
            res.set('Retry-After', String(Math.ceil(sigLimiter.windowMs / 1000)));
            return res.status(429).json({ error: 'Too many invalid requests' });
        }
        return res.status(401).json({ error: 'Invalid AppAPI shared secret' });
    }
    sigLimiter.succeed();

    /** @type {TalkActivity | null} */
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    const mapped = mapActivity(body);
    if (!mapped) {
        // Joins, leaves and system messages land here. 200 so Talk does not
        // treat the bot as unhealthy.
        return res.json({ ignored: body?.type || null });
    }

    if (!config.tenantKey || !config.ncInstanceId) {
        return res.status(503).json({ error: 'Connector not yet bootstrapped' });
    }

    // "@ in Talk": a human @mentioning the bot gets an inline agent answer, on
    // top of (not instead of) the automations forward below. Only humans, never a
    // bot's own messages — that would be an answer-to-my-own-answer loop.
    // Fire-and-forget so the webhook still returns promptly.
    if (mapped.event === 'talk.message.received'
        && mapped.payload.actorType === 'users'
        && mentionsBot(mapped.payload)) {
        handleMention(mapped.payload)
            .catch(err => log.warn(`[TalkBot] handleMention crashed: ${errMessage(err)}`));
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

    // Answer Talk first, forward afterwards. The forward may take up to 10 s,
    // which can outlast the time Talk (through AppAPI's bot proxy) gives a
    // webhook before it counts the delivery as failed; the outcome of the
    // forward is only ever logged, so Talk has nothing to wait for.
    res.json({ ok: true, event: mapped.event });
    forwardToBeeFlow(apiPath, payloadBody, `${ts}.${sig}`, /** @type {string} */ (config.ncInstanceId))
        .catch(err => log.warn(`[TalkBot] forward failed: ${errMessage(err)}`));
});

/**
 * @param {string} apiPath
 * @param {string} payloadBody
 * @param {string} signature
 * @param {string} ncInstanceId
 */
async function forwardToBeeFlow(apiPath, payloadBody, signature, ncInstanceId) {
    const r = await fetch(`${config.apiBaseUrl}${apiPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': ncInstanceId,
            'X-Beeflow-Sig': signature,
        },
        body: payloadBody,
        signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        log.warn(`[TalkBot] SaaS returned ${r.status}: ${t.slice(0, 200)}`);
    }
}

module.exports = Object.assign(router, {
    registerTalkBot,
    unregisterTalkBot,
    verifyInboundAppApi,
    mapActivity,
    loadSecret,
    saveSecret,
    mentionsBot,
    extractQuestion,
    BOT_ROUTE,
    BOT_NAME,
});
