// Talk refuses a chat message over 32,000 characters (spreed docs/bots.md), so
// a long agent answer is cut before it is posted. The cut was a plain
// String.slice, which counts UTF-16 code units: an emoji that straddles the
// limit was split, leaving a lone high surrogate at the end. JSON.stringify
// escapes that as "\ud83d", PHP's json_decode rejects an unpaired surrogate,
// and Talk answered 400 — so the user who asked got no answer at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-talk-limit-'));

const talkBot = require('../src/talkBot');

test.after(() => fs.rmSync(process.env.APP_PERSISTENT_STORAGE, { recursive: true, force: true }));

/** Post `message` as the bot and return what went on the wire. */
async function posted(message) {
    talkBot.saveSecret('s'.repeat(64));
    const realFetch = global.fetch;
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, status: 201, text: async () => '' };
    };
    try {
        await talkBot._postBotMessage('room1', message, null);
    } finally {
        global.fetch = realFetch;
    }
    assert.equal(calls.length, 1);
    return { raw: String(calls[0].init.body), message: JSON.parse(String(calls[0].init.body)).message };
}

test('a message under the limit is posted unchanged', async () => {
    const { message } = await posted('hello 😀');
    assert.equal(message, 'hello 😀');
});

test('a long message is cut to at most 32,000 characters', async () => {
    const { message } = await posted('a'.repeat(40_000));
    assert.equal(message.length, 32_000);
});

test('the cut never splits an emoji into a lone surrogate', async () => {
    // 31,999 code units, then a two-unit emoji straddling unit 32,000.
    const { raw, message } = await posted(`${'a'.repeat(31_999)}😀 and more text after it`);
    assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(raw),
        'the JSON body carries an unpaired surrogate escape, which PHP json_decode rejects');
    assert.equal(message, 'a'.repeat(31_999));
    assert.ok(message.isWellFormed());
});
