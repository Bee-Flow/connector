// #402: the connector shipped no translations. A Dutch Nextcloud showed the
// Files menu, the admin settings form, the Talk bot's replies and the
// Assistant's task errors in English.
//
//   - l10n/<lang>.js + .json in Nextcloud's format carry the static strings
//     (Nextcloud translates them in the browser);
//   - the connector's runtime messages follow the user's Nextcloud language.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-l10n-'));

const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const l10n = require('../src/l10n');
const talkBot = require('../src/talkBot');
const tp = require('../src/taskProcessing');
const { ACTIONS } = require('../src/filesActions');
const { FORM_SCHEME } = require('../src/declarativeSettings');

const L10N_DIR = path.join(__dirname, '..', 'l10n');
const nl = JSON.parse(fs.readFileSync(path.join(L10N_DIR, 'nl.json'), 'utf8'));

test.after(() => {
    tp.stopPolling();
    fs.rmSync(process.env.APP_PERSISTENT_STORAGE, { recursive: true, force: true });
});

/** What Nextcloud's page does with l10n/nl.js: run it against OC.L10N.register. */
function registeredByJs(file) {
    const calls = [];
    const OC = { L10N: { register: (app, translations, plural) => calls.push({ app, translations, plural }) } };
    vm.runInNewContext(fs.readFileSync(path.join(L10N_DIR, file), 'utf8'), { OC });
    return calls;
}

/** Every user-facing string the connector hands Nextcloud to show. */
function staticStrings() {
    const out = ACTIONS.map((a) => a.displayName);
    out.push(FORM_SCHEME.description);
    for (const f of FORM_SCHEME.fields) {
        out.push(f.title, f.description);
        for (const o of f.options || []) if (!o.name.includes('://')) out.push(o.name);
    }
    return out;
}

const TALK_STRINGS = [
    'Hi! Mention me with a question — e.g. "@Bee Flow what changed in my calendar today?"',
    'I could not find an answer to that.',
    'Sorry — I could not answer that just now. Please try again in a moment.',
];

test('l10n/nl.js registers exactly the translations of l10n/nl.json, for this app', () => {
    const calls = registeredByJs('nl.js');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].app, 'bee_flow', 'the app id Nextcloud looks the strings up under');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].translations)), nl.translations); // another realm's object
    assert.equal(calls[0].plural, nl.pluralForm);
});

test('every menu label, settings text and runtime message has a Dutch translation', () => {
    const missing = [...staticStrings(), ...TALK_STRINGS, ...Object.values(tp.USER_ERRORS)]
        .filter((s) => !nl.translations[s]);
    assert.deepEqual(missing, []);
    for (const [en, nlText] of Object.entries(nl.translations)) {
        assert.notEqual(nlText.trim(), '', `empty translation for "${en}"`);
    }
});

test('the user\'s Nextcloud language picks the dictionary; anything else is English', () => {
    for (const code of ['nl', 'nl_NL', 'nl-BE', 'NL']) assert.equal(l10n.normaliseLanguage(code), 'nl', code);
    for (const code of ['en', 'en_GB', 'de', '', null, undefined, '../../etc/passwd']) {
        assert.equal(l10n.normaliseLanguage(code), 'en', String(code));
    }
    assert.equal(l10n.t('nl', 'I could not find an answer to that.'), 'Daar kon ik geen antwoord op vinden.');
    assert.equal(l10n.t('nl', 'a string nobody translated'), 'a string nobody translated');
    assert.equal(l10n.t('en', 'I could not find an answer to that.'), 'I could not find an answer to that.');
});

/** A Nextcloud whose users have these language preferences; records what the Talk bot posts. */
function ncWithLanguages(languages, extra) {
    const posted = [];
    const world = installFakeWorld({
        nc: (method, url, init) => {
            const user = /\/cloud\/users\/([^?]+)/.exec(url);
            if (user) {
                const uid = decodeURIComponent(user[1]);
                return ocs({ id: uid, email: null, displayname: uid, groups: [], language: languages[uid] ?? '' });
            }
            if (method === 'POST' && url.includes('/apps/spreed/api/v1/bot/')) {
                posted.push(JSON.parse(String(init.body)).message);
                return json({ ocs: { data: {} } }, 201);
            }
            return extra ? extra(method, url, init) : undefined;
        },
    });
    return { world, posted };
}

test('Talk: the bot answers a Dutch user in Dutch and an English user in English', async (t) => {
    talkBot.saveSecret('bot-secret');
    const { world, posted } = ncWithLanguages({ 'l10n-jan': 'nl_NL', 'l10n-ann': 'en' });
    t.after(() => world.restore());

    // A mention without a question gets the bot's own hint.
    await talkBot.handleMention({ roomToken: 'r1', actor: 'l10n-jan', message: '@Bee Flow', messageId: 1 });
    await talkBot.handleMention({ roomToken: 'r1', actor: 'l10n-ann', message: '@Bee Flow', messageId: 2 });

    assert.equal(posted[0], nl.translations[TALK_STRINGS[0]]);
    assert.equal(posted[1], TALK_STRINGS[0]);
});

test('Talk: the "could not answer" reply follows the asker\'s language too', async (t) => {
    talkBot.saveSecret('bot-secret');
    config.ncInstanceId = 'inst-1';
    const { world, posted } = ncWithLanguages({ 'l10n-piet': 'nl' });
    t.after(() => world.restore());
    // The Bee Flow server is down: the bot apologises.
    const saas = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).startsWith(config.apiBaseUrl) ? json({ error: 'down' }, 503) : saas(url, init));
    t.after(() => { globalThis.fetch = saas; });

    await talkBot.handleMention({ roomToken: 'r1', actor: 'l10n-piet', message: '@Bee Flow wat staat er morgen?', messageId: 3 });
    assert.deepEqual(posted, [nl.translations[TALK_STRINGS[2]]]);
});

test('Assistant: a failed task reports its user-facing error in the task user\'s language', async (t) => {
    config.ncInstanceId = 'inst-1';
    const reported = [];
    let served = false;
    const { world } = ncWithLanguages({ 'l10n-mira': 'nl' }, (method, url, init) => {
        if (url.includes('/tasks_provider/next')) {
            if (served) return json({}, 404);
            served = true;
            return ocs({ task: { id: 77, type: 'core:text2text', userId: 'l10n-mira', input: { input: 'x' } } });
        }
        if (method === 'POST' && /\/tasks_provider\/77\/result/.test(url)) {
            reported.push(JSON.parse(String(init.body)));
            return ocs({});
        }
        return undefined;
    });
    t.after(() => world.restore());
    const nc = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).startsWith(config.apiBaseUrl) ? json({ error: 'broken' }, 500) : nc(url, init));
    t.after(() => { globalThis.fetch = nc; });

    await tp.drainProvider(tp.providerId('core:text2text'), { concurrency: 1 });

    assert.equal(reported.length, 1);
    assert.equal(reported[0].userFacingErrorMessage, nl.translations[tp.USER_ERRORS.upstream]);
    assert.match(reported[0].errorMessage, /500/, 'the admin detail stays as it was');
});
