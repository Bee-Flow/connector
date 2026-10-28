// #404: the Talk bot kept ONE agent thread per room (`talk:<room>`), owned by
// whoever asked first. The Bee Flow server never lets anyone else continue a
// thread they do not own, so every other user in the room started without
// context on every question. Now each user has their own thread per room,
// `talk:<room>:<uid>`, and nobody ever sees another user's context.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-talk-threads-'));

const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const talkBot = require('../src/talkBot');

test.after(() => fs.rmSync(process.env.APP_PERSISTENT_STORAGE, { recursive: true, force: true }));

/**
 * The Bee Flow server's agent threads as it keeps them: by conversation
 * token, owned by the user whose turn created it, and a token owned by
 * someone else starts a fresh conversation (routes/nextcloudTaskProcessing.js).
 */
function fakeAgentServer() {
    const threads = new Map();
    const turns = [];
    const execute = (init) => {
        const { input, ncUid } = JSON.parse(String(init.body));
        const token = input.conversation_token;
        const thread = threads.get(token);
        const continued = !!thread && thread.owner === ncUid;
        // A foreign token is left to its owner; the asker gets a fresh thread.
        if (!thread) threads.set(token, { owner: ncUid });
        turns.push({ ncUid, token, continued });
        return { output: { output: continued ? `(continuing) ${input.input}` : input.input } };
    };
    return { execute, turns };
}

test('two users in one room each keep their own conversation with the bot', async (t) => {
    talkBot.saveSecret('bot-secret');
    config.ncInstanceId = 'inst-1';
    const agent = fakeAgentServer();
    const world = installFakeWorld({
        servers: { [config.apiBaseUrl]: { 'POST /api/nextcloud/task-processing/execute': agent.execute } },
        nc: (method, url) => {
            const user = /\/cloud\/users\/([^?]+)/.exec(url);
            if (user) return ocs({ id: decodeURIComponent(user[1]), groups: [], language: 'en' });
            if (method === 'POST' && url.includes('/apps/spreed/api/v1/bot/')) return json({ ocs: { data: {} } }, 201);
            return undefined;
        },
    });
    t.after(() => world.restore());

    const ask = (actor, message, messageId) => talkBot.handleMention({ roomToken: 'room1', actor, message: `@Bee Flow ${message}`, messageId });
    await ask('alice', 'what is on my agenda?', 1);
    await ask('bob', 'and the budget file?', 2);
    await ask('alice', 'and tomorrow?', 3);
    await ask('bob', 'who changed it last?', 4);

    assert.deepEqual(agent.turns.map((x) => [x.ncUid, x.token, x.continued]), [
        ['alice', 'talk:room1:alice', false],
        ['bob', 'talk:room1:bob', false],
        ['alice', 'talk:room1:alice', true],
        ['bob', 'talk:room1:bob', true], // with one room thread, bob never got a follow-up
    ]);
});

test('the same user has a separate thread in each room', () => {
    assert.equal(talkBot.talkConversationToken('room1', 'alice'), 'talk:room1:alice');
    assert.notEqual(talkBot.talkConversationToken('room2', 'alice'), talkBot.talkConversationToken('room1', 'alice'));
    // The pre-#404 room thread is never what a user continues: it stays its first owner's.
    assert.notEqual(talkBot.talkConversationToken('room1', 'alice'), 'talk:room1');
});
