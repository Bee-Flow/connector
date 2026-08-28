/**
 * Talk bot: inbound AppAPI authentication and Activity Streams mapping.
 *
 * The bot is registered THROUGH AppAPI, so Talk POSTs deliveries to AppAPI,
 * AppAPI verifies the Talk HMAC itself and forwards to this ExApp route with a
 * null userId — i.e. the only auth that reaches /hooks/talk is the AppAPI shared
 * secret (base64(":"+APP_SECRET) + EX-APP-ID), NOT the X-Nextcloud-Talk-*
 * signature headers. So the connector authenticates the shared secret; a
 * Talk-signature check here 401s every real delivery. These tests exercise that
 * boundary in the exact shape AppAPI forwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
// Keep the secret file out of the real persistent-storage path.
process.env.APP_PERSISTENT_STORAGE = process.env.APP_PERSISTENT_STORAGE
    || fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-talkbot-'));

const talkBot = require('../src/talkBot');
const config = require('../src/config');

const appApiAuth = (userId, secret) => Buffer.from(`${userId}:${secret}`).toString('base64');

// ── Inbound AppAPI shared-secret auth (the real delivery boundary) ──────────

test('a delivery carrying the AppAPI shared secret (empty userId) is accepted', () => {
    const req = { headers: { 'authorization-app-api': appApiAuth('', config.appSecret) } };
    assert.equal(talkBot.verifyInboundAppApi(req), true);
});

test('a wrong shared secret is rejected', () => {
    const req = { headers: { 'authorization-app-api': appApiAuth('', 'not-the-secret') } };
    assert.equal(talkBot.verifyInboundAppApi(req), false);
});

test('a missing auth header is rejected', () => {
    assert.equal(talkBot.verifyInboundAppApi({ headers: {} }), false);
});

test('a mismatched EX-APP-ID is rejected even with the right secret', () => {
    const req = { headers: { 'authorization-app-api': appApiAuth('', config.appSecret), 'ex-app-id': 'some_other_app' } };
    assert.equal(talkBot.verifyInboundAppApi(req), false);
});

test('the matching EX-APP-ID passes', () => {
    const req = { headers: { 'authorization-app-api': appApiAuth('', config.appSecret), 'ex-app-id': config.appId } };
    assert.equal(talkBot.verifyInboundAppApi(req), true);
});

// ── Route-level: the shape AppAPI actually forwards ─────────────────────────
// This is the test that would have caught the shipped-but-dead feature: a POST
// to /hooks/talk with AppAPI auth headers, an Activity-Streams JSON body, and NO
// X-Nextcloud-Talk-* headers.

function startRouter() {
    const app = express();
    app.use('/', talkBot);
    const server = app.listen(0);
    return { server, port: server.address().port };
}

test('a forwarded delivery with the AppAPI secret is accepted (200) and forwarded to the SaaS', async () => {
    config.tenantKey = 'test-tenant-key';
    config.ncInstanceId = 'nc-instance';
    const { server, port } = startRouter();
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; };
    try {
        const body = {
            type: 'Create',
            actor: { id: 'users/ada', name: 'Ada' },
            object: { id: '9', name: 'message', content: JSON.stringify({ message: 'hello there' }) },
            target: { id: 'room1', name: 'General' },
            // AppAPI injects these route params into the forwarded JSON — mapActivity ignores them.
            appId: config.appId,
            route: '/hooks/talk',
        };
        const r = await realFetch(`http://127.0.0.1:${port}/hooks/talk`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization-app-api': appApiAuth('', config.appSecret),
                'ex-app-id': config.appId,
            },
            body: JSON.stringify(body),
        });
        assert.equal(r.status, 200, 'a genuine AppAPI-forwarded delivery must be accepted');
        assert.ok(
            calls.some(u => u.includes('/api/automation/events/nextcloud')),
            'the mapped event is forwarded to the SaaS',
        );
    } finally {
        global.fetch = realFetch;
        server.close();
    }
});

test('a delivery with a wrong AppAPI secret is rejected with 401', async () => {
    const { server, port } = startRouter();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/hooks/talk`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization-app-api': appApiAuth('', 'wrong') },
            body: JSON.stringify({ type: 'Create' }),
        });
        assert.equal(r.status, 401);
    } finally {
        server.close();
    }
});

// ── Activity Streams mapping ───────────────────────────────────────────────

test('a chat message maps to talk.message.received with the content unwrapped', () => {
    const mapped = talkBot.mapActivity({
        type: 'Create',
        actor: { type: 'Person', id: 'users/ada-lovelace', name: 'Ada Lovelace' },
        object: {
            type: 'Note',
            id: '1567',
            name: 'message',
            content: JSON.stringify({ message: 'hi {mention-call1} !', parameters: { 'mention-call1': { type: 'call' } } }),
            mediaType: 'text/markdown',
        },
        target: { type: 'Collection', id: 'n3xtc10ud', name: 'world' },
    });
    assert.equal(mapped.event, 'talk.message.received');
    assert.equal(mapped.payload.messageId, '1567');
    assert.equal(mapped.payload.roomToken, 'n3xtc10ud');
    assert.equal(mapped.payload.roomName, 'world');
    // actor.id is "<type>/<id>" — the bare uid is what every other tool wants.
    assert.equal(mapped.payload.actor, 'ada-lovelace');
    assert.equal(mapped.payload.actorName, 'Ada Lovelace');
    assert.equal(mapped.payload.message, 'hi {mention-call1} !');
    assert.equal(mapped.payload.isMarkdown, true);
    assert.ok(mapped.payload.parameters, 'rich-object parameters are preserved for rendering mentions');
});

test('a message whose content is not JSON still produces text', () => {
    const mapped = talkBot.mapActivity({
        type: 'Create',
        actor: { id: 'users/bob' },
        object: { id: '9', name: 'message', content: 'plain text' },
        target: { id: 'tok' },
    });
    assert.equal(mapped.payload.message, 'plain text');
});

test('a reaction maps to talk.reaction.added and carries the emoji', () => {
    const mapped = talkBot.mapActivity({
        type: 'Like',
        actor: { id: 'users/ada-lovelace', name: 'Ada Lovelace' },
        object: { id: '1567', name: 'message' },
        target: { id: 'n3xtc10ud', name: 'world' },
        content: '\u{1F44D}',
    });
    assert.equal(mapped.event, 'talk.reaction.added');
    assert.equal(mapped.payload.reaction, '\u{1F44D}');
    assert.equal(mapped.payload.messageId, '1567');
    assert.equal(mapped.payload.removed, false);
    // Which KIND of attendee reacted decides whether it can ever be a vote:
    // approval-by-emoji only counts a real user, never a guest and never the
    // bot's own seeded reaction coming back at us.
    assert.equal(mapped.payload.actorType, 'users');
});

test('un-reacting reads the Undo envelope, which nests the original Like', () => {
    // Talk's Undo is NOT shaped like a Like (spreed docs/bots.md): `object` is
    // the whole original Like, so the message sits one level deeper and the
    // emoji is object.content. Reading it as a Like — which this connector did
    // — produced a removal with a null messageId and an empty reaction.
    const mapped = talkBot.mapActivity({
        type: 'Undo',
        actor: { id: 'users/ada', name: 'Ada' },
        object: {
            type: 'Like',
            actor: { id: 'users/ada', name: 'Ada' },
            object: { type: 'Note', id: '1567', name: 'message' },
            target: { type: 'Collection', id: 'n3xtc10ud', name: 'world' },
            content: '\u{1F44D}',
        },
        target: { type: 'Collection', id: 'n3xtc10ud', name: 'world' },
    });
    assert.equal(mapped.event, 'talk.reaction.added');
    assert.equal(mapped.payload.removed, true);
    assert.equal(mapped.payload.messageId, '1567');
    assert.equal(mapped.payload.reaction, '\u{1F44D}');
    assert.equal(mapped.payload.roomToken, 'n3xtc10ud');
});

test('a bot’s own reaction is reported as a bot, not as a person', () => {
    const mapped = talkBot.mapActivity({
        type: 'Like',
        actor: { id: 'bots/bot-abc123', name: 'Bee Flow' },
        object: { id: '1567', name: 'message' },
        target: { id: 'tok', name: 'room' },
        content: '\u{1F44D}',
    });
    assert.equal(mapped.payload.actorType, 'bots');
    assert.equal(mapped.payload.actor, 'bot-abc123');
});

test('joins, leaves and system messages produce no trigger', () => {
    assert.equal(talkBot.mapActivity({ type: 'Join', actor: { id: 'bots/bot-x' }, object: { id: 'tok' } }), null);
    assert.equal(talkBot.mapActivity({ type: 'Leave', actor: { id: 'bots/bot-x' }, object: { id: 'tok' } }), null);
    // A system message has object.name set to a system identifier, not "message".
    assert.equal(talkBot.mapActivity({
        type: 'Create', actor: { id: 'users/a' }, object: { id: '1', name: 'call_started' }, target: { id: 't' },
    }), null);
    assert.equal(talkBot.mapActivity(null), null);
    assert.equal(talkBot.mapActivity('nonsense'), null);
});
