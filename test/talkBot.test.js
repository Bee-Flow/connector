/**
 * Talk bot: signature verification and Activity Streams mapping.
 *
 * The signature is the only thing standing between an arbitrary caller and the
 * ability to inject fabricated chat messages into a customer's automations, so
 * the negative cases matter more than the positive one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
// Keep the secret file out of the real persistent-storage path.
process.env.APP_PERSISTENT_STORAGE = process.env.APP_PERSISTENT_STORAGE
    || fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-talkbot-'));

const talkBot = require('../src/talkBot');

const SECRET = 'a'.repeat(64);
const RANDOM = 'r'.repeat(64);

function sign(secret, random, body) {
    return crypto.createHmac('sha256', secret).update(random + body).digest('hex');
}

function reqFor({ body, random = RANDOM, signature, headers = {} }) {
    return {
        rawBody: body,
        headers: {
            'x-nextcloud-talk-random': random,
            'x-nextcloud-talk-signature': signature ?? sign(SECRET, random, body),
            ...headers,
        },
    };
}

test('a correctly signed delivery verifies', () => {
    talkBot.saveSecret(SECRET);
    const body = JSON.stringify({ type: 'Create' });
    assert.equal(talkBot.verifyTalkSignature(reqFor({ body })), true);
});

test('a tampered body is rejected', () => {
    talkBot.saveSecret(SECRET);
    const signature = sign(SECRET, RANDOM, JSON.stringify({ type: 'Create' }));
    const req = reqFor({ body: JSON.stringify({ type: 'Create', injected: true }), signature });
    assert.equal(talkBot.verifyTalkSignature(req), false);
});

test('a signature made with a different secret is rejected', () => {
    talkBot.saveSecret(SECRET);
    const body = JSON.stringify({ type: 'Create' });
    assert.equal(talkBot.verifyTalkSignature(reqFor({ body, signature: sign('b'.repeat(64), RANDOM, body) })), false);
});

test('a swapped random is rejected', () => {
    talkBot.saveSecret(SECRET);
    const body = JSON.stringify({ type: 'Create' });
    const signature = sign(SECRET, RANDOM, body);
    assert.equal(talkBot.verifyTalkSignature(reqFor({ body, random: 'z'.repeat(64), signature })), false);
});

test('a short random is rejected even if the HMAC matches', () => {
    // A 4-character random would make the signature brute-forceable offline.
    talkBot.saveSecret(SECRET);
    const body = JSON.stringify({ type: 'Create' });
    const short = 'abcd';
    assert.equal(talkBot.verifyTalkSignature(reqFor({ body, random: short, signature: sign(SECRET, short, body) })), false);
});

test('missing headers are rejected', () => {
    talkBot.saveSecret(SECRET);
    assert.equal(talkBot.verifyTalkSignature({ rawBody: '{}', headers: {} }), false);
});

test('no secret means nothing verifies — fail closed', () => {
    talkBot.saveSecret('');
    const body = JSON.stringify({ type: 'Create' });
    assert.equal(talkBot.verifyTalkSignature(reqFor({ body })), false);
    talkBot.saveSecret(SECRET);
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
});

test('un-reacting is flagged rather than looking like a new reaction', () => {
    const mapped = talkBot.mapActivity({
        type: 'Undo', actor: { id: 'users/ada' }, object: { id: '1' }, target: { id: 't' }, content: '\u{1F44D}',
    });
    assert.equal(mapped.event, 'talk.reaction.added');
    assert.equal(mapped.payload.removed, true);
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
