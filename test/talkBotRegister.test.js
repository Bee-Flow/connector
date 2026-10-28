/**
 * Talk bot registration on restart (#281). AppAPI mints a new secret on every
 * registration and Talk refuses a second secret for the same bot URL with an
 * OCS 500, so every start after the first gets that 500:
 *   - no stored secret (fresh volume): remove the bot, register again, keep the
 *     new secret;
 *   - a stored secret: that is the bot Talk has; keep it, no DELETE (a delete
 *     would drop the bot from every conversation).
 * Together with shutdown.js (no unregister on SIGTERM), a restart leaves the
 * bot in every room it was added to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = 'ci-test-secret';
process.env.NEXTCLOUD_URL = 'http://nextcloud.invalid';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-talkbot-register-'));

const talkBot = require('../src/talkBot');

const conflict = () => new Response('{"ocs":{"meta":{"statuscode":996}}}', { status: 500 });
const registered = (secret) => new Response(JSON.stringify({ ocs: { data: { secret } } }), { status: 200 });

async function withFetch(answers, fn) {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ method: init.method || 'GET', url: String(url), headers: init.headers || {} });
        const next = answers.shift();
        return typeof next === 'function' ? next() : next;
    };
    try {
        return { result: await fn(), calls };
    } finally {
        globalThis.fetch = realFetch;
    }
}

test.after(() => fs.rmSync(process.env.APP_PERSISTENT_STORAGE, { recursive: true, force: true }));

test('a refused registration without a stored secret removes the bot and registers again', async () => {
    assert.equal(talkBot.loadSecret(), null);
    const { result, calls } = await withFetch(
        [conflict(), new Response('{}', { status: 200 }), registered('fresh-secret')],
        () => talkBot.registerTalkBot());
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE', 'POST']);
    assert.ok(calls.every((c) => c.url.endsWith('/apps/app_api/api/v1/talk_bot')));
    // These calls go to Nextcloud itself and must carry the AppAPI credential.
    assert.ok(calls.every((c) => c.headers['AUTHORIZATION-APP-API']));
    assert.equal(result.ok, true);
    assert.equal(talkBot.loadSecret(), 'fresh-secret');
});

test('a refused re-registration with a stored secret keeps it and deletes nothing', async () => {
    const { result, calls } = await withFetch([conflict()], () => talkBot.registerTalkBot());
    assert.deepEqual(calls.map((c) => c.method), ['POST']);
    assert.deepEqual(result, { ok: true, reason: 'kept-existing' });
    assert.equal(talkBot.loadSecret(), 'fresh-secret');
});

test('Talk not installed is still reported as such, without a DELETE', async () => {
    const { result, calls } = await withFetch([new Response('', { status: 404 })], () => talkBot.registerTalkBot());
    assert.deepEqual(calls.map((c) => c.method), ['POST']);
    assert.equal(result.reason, 'talk-missing');
});
