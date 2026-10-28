/**
 * "@ in Talk": the bot answers when a human @mentions it. These cover the two
 * fiddly pure functions — is the bot mentioned, and what's the question once the
 * mention is stripped — plus the loop guard (never answer a bot's own message).
 */
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nc.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mentionsBot, extractQuestion, mapActivity, BOT_NAME } = require('../src/talkBot');

test('a structured mention parameter naming the bot counts as a mention', () => {
    assert.equal(mentionsBot({
        message: '{mention-user1} what changed today?',
        parameters: { 'mention-user1': { type: 'user', id: 'bot-42', name: BOT_NAME } },
    }), true);
});

test('a literal "@Bee Flow" counts as a mention when the message carries no mention parameters', () => {
    assert.equal(mentionsBot({ message: 'hey @Bee Flow, summarise this' }), true);
    assert.equal(mentionsBot({ message: '@beeflow help', parameters: {} }), true);
});

// "the Bee Flow report is late" used to start an agent run as the sender and
// post the answer to the room.
test('the words "Bee Flow" without an @ are not a mention', () => {
    assert.equal(mentionsBot({ message: 'the Bee Flow report is late' }), false);
    assert.equal(mentionsBot({ message: 'HEY BEE FLOW help' }), false);
});

test('mention parameters that name someone else win over the text', () => {
    assert.equal(mentionsBot({
        message: '{mention-user1} can you check the @Bee Flow report?',
        parameters: { 'mention-user1': { type: 'user', id: 'ada', name: 'Ada' } },
    }), false);
});

test('an unrelated message with an unrelated mention is not a mention of the bot', () => {
    assert.equal(mentionsBot({
        message: '{mention-user1} lunch?',
        parameters: { 'mention-user1': { type: 'user', id: 'ada', name: 'Ada' } },
    }), false);
    assert.equal(mentionsBot({ message: 'just chatting about the weather' }), false);
});

test('extractQuestion strips the mention placeholder and the literal bot name', () => {
    assert.equal(
        extractQuestion({ message: '{mention-user1} what is in my calendar tomorrow?' }),
        'what is in my calendar tomorrow?',
    );
    assert.equal(
        extractQuestion({ message: '@Bee Flow   summarise the last 10 messages' }),
        'summarise the last 10 messages',
    );
});

test('extractQuestion yields empty when the message is only a mention', () => {
    assert.equal(extractQuestion({ message: '{mention-user1}' }), '');
    assert.equal(extractQuestion({ message: '@Bee Flow' }), '');
});

test('mapActivity exposes actorType so the loop guard can exclude bots', () => {
    const human = mapActivity({
        type: 'Create',
        actor: { id: 'users/tomsmit', name: 'Tom' },
        object: { id: 5, name: 'message', content: JSON.stringify({ message: '@Bee Flow hi' }) },
        target: { id: 'room1', name: 'Team' },
    });
    assert.equal(human.payload.actorType, 'users');

    const bot = mapActivity({
        type: 'Create',
        actor: { id: 'bots/9', name: 'Bee Flow' },
        object: { id: 6, name: 'message', content: JSON.stringify({ message: 'my own answer' }) },
        target: { id: 'room1', name: 'Team' },
    });
    assert.equal(bot.payload.actorType, 'bots', 'a bot message must be identifiable so we never answer it');
});
