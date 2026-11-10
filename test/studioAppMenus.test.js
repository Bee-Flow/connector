/**
 * Studio-app top-menu publication (src/studioAppMenus.js).
 *
 * Three contracts pinned here:
 *   1. The menu-name mapping round-trips UUIDs losslessly — the embedded page
 *      script has ONLY the entry name in its URL to work from.
 *   2. The reconcile loop registers/unregisters against AppAPI exactly per the
 *      SaaS list, persists its state, and NEVER unregisters on a failed list
 *      fetch (a SaaS hiccup must not flap the org's menu).
 *   3. The list fetch is signed with the same tenant-key HMAC scheme the SaaS
 *      verifies in server/auth/connectorSig.js — `${ts}\nGET\n${path}\n`.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-menus-'));

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const config = require('../src/config');
const menus = require('../src/studioAppMenus');

const UUID = '4c6cbdcf-6a7e-4d9b-9f6e-2f1f5c1d0a01';
const NAME = menus.menuNameForAppId(UUID);

// ── Name mapping ────────────────────────────────────────────────────

test('menu names round-trip crypto.randomUUID() app ids', () => {
    assert.strictEqual(menus.appIdForMenuName(NAME), UUID);
    // Anything that cannot round-trip is refused, not mangled.
    assert.strictEqual(menus.menuNameForAppId('not-a-uuid'), null);
    assert.strictEqual(menus.appIdForMenuName('sa_zz'), null);
    assert.strictEqual(menus.appIdForMenuName('main'), null);
    // The OLD hex encoding must no longer be accepted — those names never
    // registered (they did not fit the column) and must not be resurrected.
    assert.strictEqual(menus.appIdForMenuName('sa_4c6cbdcf6a7e4d9b9f6e2f1f5c1d0a01'), null);
});

/**
 * THE regression guard for the 1.4.0 outage.
 *
 * `oc_ex_ui_top_menu`.name is varchar(32). A longer name is not truncated —
 * AppAPI answers OCS statuscode 400 while still returning HTTP 200, so it
 * looks exactly like success. `sa_` + 32 hex chars = 35 meant EVERY studio-app
 * menu entry was silently refused. Round-tripping is not enough: the name has
 * to fit, for every possible id.
 */
test('every menu name fits the varchar(32) column, and still round-trips', () => {
    const crypto = require('node:crypto');
    for (let i = 0; i < 500; i++) {
        const id = crypto.randomUUID();
        const name = menus.menuNameForAppId(id);
        assert.ok(name, `no name produced for ${id}`);
        assert.ok(name.length <= 32, `name ${name} is ${name.length} chars — the column holds 32`);
        assert.match(name, /^sa_[a-z2-7]+$/, 'lowercase alphanumeric only — no escaping in the URL path');
        assert.strictEqual(menus.appIdForMenuName(name), id, `round-trip lost ${id}`);
    }
});

test('display names are capped to the column too, visibly', () => {
    // display_name is varchar(32) as well; an over-long app name used to take
    // the whole entry down with the same silent 400.
    const long = 'Customer relationship management pipeline 2026';
    const fitted = menus.fitDisplayName(long);
    assert.ok(fitted.length <= 32, `${fitted.length} chars`);
    assert.match(fitted, /…$/, 'truncation is visible, not silent');
    assert.strictEqual(menus.fitDisplayName('CRM pipeline'), 'CRM pipeline');
    assert.strictEqual(menus.fitDisplayName('   '), 'App');
});

// ── The embedded page script ────────────────────────────────────────

function runEmbedScript(pathname) {
    const script = menus.buildEmbedAppScript();
    const iframe = { style: { cssText: '', height: '' }, getBoundingClientRect: () => ({ top: 50 }) };
    const content = { textContent: '', innerHTML: 'old', children: [], appendChild(el) { this.children.push(el); } };
    const sandbox = {
        document: { getElementById: () => content, createElement: () => iframe },
        OC: { generateUrl: (p) => '/index.php' + p },
        window: { location: { pathname }, innerHeight: 900, addEventListener() {} },
        setTimeout: () => {},
        ResizeObserver: undefined,
    };
    new Function('document', 'OC', 'window', 'setTimeout', 'ResizeObserver', script)(
        sandbox.document, sandbox.OC, sandbox.window, sandbox.setTimeout, sandbox.ResizeObserver,
    );
    return { iframe, content };
}

test('the page script derives the app id from the entry name and mounts the proxied run view', () => {
    const { iframe, content } = runEmbedScript(`/index.php/apps/app_api/embedded/bee_flow/${NAME}`);
    assert.strictEqual(content.children.length, 1, 'exactly one iframe mounted');
    // `index.html`, not the bare proxy root: AppAPI's PHP proxy injects the
    // CSP nonce the shell's inline bootstrap needs only for `.html` paths —
    // the bare root (what shipped before 1.6.0) framed a shell whose inline
    // scripts the CSP blocked: a working icon, a blank page.
    assert.strictEqual(
        iframe.src,
        `/index.php/apps/app_api/proxy/${config.appId}/index.html?ncStudioApp=${UUID}`,
    );
    assert.match(iframe.allow, /clipboard-read; clipboard-write/);
    // Same measured-height contract as the main embed script.
    assert.strictEqual(iframe.style.height, '850px');
});

test('under HaRP the page script frames /exapps/ — never the PHP proxy', (t) => {
    // Same branch as the main entry's script in server.js: HaRP serves the
    // shell without PHP (so no nonce is involved) and streams responses; the
    // PHP proxy would buffer every SSE stream the app opens.
    process.env.HP_SHARED_KEY = 'harp-key';
    t.after(() => { delete process.env.HP_SHARED_KEY; });
    const { iframe } = runEmbedScript(`/index.php/apps/app_api/embedded/bee_flow/${NAME}`);
    assert.strictEqual(iframe.src, `/index.php/exapps/${config.appId}/?ncStudioApp=${UUID}`);
});

test('an unrecognisable entry name renders an error, never a guessed iframe', () => {
    const { content } = runEmbedScript('/index.php/apps/app_api/embedded/bee_flow/not_an_app');
    assert.strictEqual(content.children.length, 0);
    assert.match(content.textContent, /could not be loaded/);
});

// ── Menu icons ──────────────────────────────────────────────────────

test('the entry shows the app’s OWN Lucide icon, not a stand-in', () => {
    // The whole point: the top bar must show the icon the owner picked in
    // Studio ('Contact' for a team directory), the same glyph the Bee Flow web
    // app renders — a letter tile is only the fallback.
    const svg = menus.buildEntryIconSvg('Team directory', 'Contact');
    assert.match(svg, /<svg/, 'an SVG came back');
    assert.match(svg, /lucide-contact/, 'it is the Contact glyph');
    assert.ok(!svg.includes('</text>'), 'not the letter fallback');
    // Nextcloud recolors menu icons with a CSS filter over a standalone SVG,
    // where `currentColor` has nothing to inherit from — it must be pinned.
    assert.ok(!svg.includes('currentColor'), 'currentColor is resolved to black');
    assert.match(svg, /stroke="#000000"/);
});

test('PascalCase icon names map to Lucide file names', () => {
    assert.strictEqual(menus.lucideFileName('Contact'), 'contact');
    assert.strictEqual(menus.lucideFileName('LayoutGrid'), 'layout-grid');
    assert.strictEqual(menus.lucideFileName('Building2'), 'building-2');
    assert.strictEqual(menus.lucideFileName('CircleUserRound'), 'circle-user-round');
    // Names Studio actually ships on its app tiles must all resolve.
    for (const name of ['LayoutGrid', 'Contact', 'Users', 'Kanban', 'Scissors', 'Inbox']) {
        assert.ok(menus.lucideIconSvg(name), `${name} should resolve to a glyph`);
    }
});

test('an icon name can never walk out of the icons directory', () => {
    // The name arrives from the SaaS, so it is untrusted input to a file read.
    for (const evil of ['../../../etc/passwd', '..%2f..%2fpasswd', 'foo/bar', 'a b', '/etc/passwd']) {
        assert.strictEqual(menus.lucideIconSvg(evil), null, `${evil} must not resolve`);
    }
    // …and an unknown-but-harmless name simply falls back.
    assert.strictEqual(menus.lucideIconSvg('NotARealIconName'), null);
});

test('entry icons fall back to monochrome letter glyphs with XML-safe content', () => {
    // No icon name, or one Lucide does not know → the app's first letter.
    assert.match(menus.buildEntryIconSvg('Quote intake', null), />Q<\/text>/);
    assert.match(menus.buildEntryIconSvg('Quote intake', 'NotARealIconName'), />Q<\/text>/);
    // Leading punctuation is skipped for the first real letter/digit.
    assert.match(menus.buildLetterIconSvg('  "42 things"'), />4<\/text>/);
    // XML metacharacters cannot break out of the text node.
    assert.ok(!menus.buildLetterIconSvg('<script>').includes('><<'));
    assert.match(menus.buildLetterIconSvg(null), />•<\/text>/);
    // NC recolors menu icons via CSS filters — the glyph must be plain black.
    const svg = menus.buildLetterIconSvg('Zebra');
    assert.ok(!/#(?!000000)[0-9a-fA-F]{6}/.test(svg), 'no colors other than #000000');
});

// ── Reconcile against the SaaS list + AppAPI ────────────────────────

function mockFetch(handlers) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        const call = { url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        for (const h of handlers) {
            if (h.match(u, call)) return h.respond(call);
        }
        throw new Error(`unexpected fetch: ${call.method} ${u}`);
    };
    return calls;
}

const okJson = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
});

// An OCS refusal: HTTP 200 with the real verdict inside the envelope. This is
// precisely the shape that made 1.4.0 look healthy while registering nothing.
const ocsRefusal = (statuscode = 400, message = 'Top Menu entry could not be registered') =>
    okJson({ ocs: { meta: { status: 'failure', statuscode, message } } });

function saasListHandler(apps) {
    return {
        match: (u, c) => u.includes('/api/nextcloud/studio-apps') && c.method === 'GET',
        respond: () => okJson({ apps }),
    };
}

const ocsHandler = {
    match: (u) => u.includes('/ocs/'),
    respond: () => okJson({ ocs: { meta: { statuscode: 100 } } }),
};

test('sync registers new entries, updates renames, and unregisters removed apps', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    config.tenantKey = 'tk-secret';
    config.ncInstanceId = 'nc-instance-a';
    t.after(() => { config.tenantKey = null; config.ncInstanceId = null; });

    // Round 1: one app → top-menu + script registration.
    let calls = mockFetch([saasListHandler([{ id: UUID, name: 'Quote intake', icon: 'Scissors' }]), ocsHandler]);
    let result = await menus.syncStudioAppMenus();
    assert.deepStrictEqual({ ok: result.ok, added: result.added, removed: result.removed }, { ok: true, added: 1, removed: 0 });

    const topMenuPost = calls.find(c => c.url.includes('/ui/top-menu') && c.method === 'POST');
    assert.ok(topMenuPost, 'registers the top-menu entry');
    assert.strictEqual(topMenuPost.body.name, NAME);
    assert.strictEqual(topMenuPost.body.displayName, 'Quote intake');
    assert.strictEqual(topMenuPost.body.icon, `img/studio-app/${NAME}.svg`);
    assert.strictEqual(topMenuPost.body.adminRequired, 0);

    const scriptPost = calls.find(c => c.url.includes('/ui/script') && c.method === 'POST');
    assert.ok(scriptPost, 'registers the per-entry page script');
    assert.deepStrictEqual(
        { type: scriptPost.body.type, name: scriptPost.body.name, path: scriptPost.body.path },
        { type: 'top_menu', name: NAME, path: 'js/embed-app' },
    );

    // The list fetch is signed exactly as server/auth/connectorSig.js verifies.
    const listCall = calls.find(c => c.url.includes('/api/nextcloud/studio-apps'));
    assert.strictEqual(listCall.headers['X-Beeflow-NC-Instance-Id'], 'nc-instance-a');
    const [ts, sig] = listCall.headers['X-Beeflow-Sig'].split('.');
    const expected = crypto.createHmac('sha256', 'tk-secret')
        .update(`${ts}\nGET\n/api/nextcloud/studio-apps\n`).digest('hex');
    assert.strictEqual(sig, expected);

    // State survives for the next round (and the icon route).
    assert.strictEqual(menus.loadState().entries[NAME].appId, UUID);

    // Round 2: rename → delete + re-register with the new display name.
    calls = mockFetch([saasListHandler([{ id: UUID, name: 'Quote desk', icon: 'Scissors' }]), ocsHandler]);
    result = await menus.syncStudioAppMenus();
    assert.strictEqual(result.updated, 1);
    assert.ok(calls.some(c => c.url.includes('/ui/top-menu') && c.method === 'DELETE'), 'rename re-registers');
    assert.strictEqual(menus.loadState().entries[NAME].displayName, 'Quote desk');

    // Round 3: the SaaS hiccups → nothing is unregistered.
    calls = mockFetch([{ match: (u) => u.includes('/api/nextcloud/studio-apps'), respond: () => okJson({ error: 'boom' }, 500) }, ocsHandler]);
    result = await menus.syncStudioAppMenus();
    assert.strictEqual(result.ok, false);
    assert.ok(!calls.some(c => c.method === 'DELETE'), 'a failed fetch never flaps the menu');
    assert.ok(menus.loadState().entries[NAME], 'state kept');

    // Round 4: the app is gone (unpublished/opted out/deleted) → unregistered.
    calls = mockFetch([saasListHandler([]), ocsHandler]);
    result = await menus.syncStudioAppMenus();
    assert.strictEqual(result.removed, 1);
    assert.ok(calls.some(c => c.url.includes('/ui/top-menu') && c.method === 'DELETE'));
    assert.ok(calls.some(c => c.url.includes('/ui/script') && c.method === 'DELETE'));
    assert.strictEqual(Object.keys(menus.loadState().entries).length, 0);
});

test('an OCS refusal inside a 200 is a failure, and is NOT recorded as registered', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    config.tenantKey = 'tk-secret';
    config.ncInstanceId = 'nc-instance-a';
    t.after(() => { config.tenantKey = null; config.ncInstanceId = null; });

    const calls = mockFetch([
        saasListHandler([{ id: UUID, name: 'Quote intake', icon: 'Scissors' }]),
        { match: (u) => u.includes('/ui/top-menu'), respond: () => ocsRefusal() },
        ocsHandler,
    ]);
    const result = await menus.syncStudioAppMenus();

    // The sync survives (one bad entry must not stop the others)…
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.added, 0, 'a refused entry must not count as added');
    // …but nothing is persisted, so the next tick RETRIES instead of believing
    // a registration that never happened.
    assert.strictEqual(menus.loadState().entries[NAME], undefined, 'refused entry must not be recorded');
    assert.ok(calls.some(c => c.url.includes('/ui/top-menu') && c.method === 'POST'));
});

test('sync is a silent no-op until bootstrap has bound a tenant', async () => {
    config.tenantKey = null;
    config.ncInstanceId = null;
    const result = await menus.syncStudioAppMenus();
    assert.deepStrictEqual(result, { ok: true, skipped: 'not_bootstrapped' });
});

test('an older Bee Flow server without the endpoint disables the feature quietly', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    config.tenantKey = 'tk-secret';
    config.ncInstanceId = 'nc-instance-a';
    t.after(() => { config.tenantKey = null; config.ncInstanceId = null; });

    mockFetch([{ match: (u) => u.includes('/api/nextcloud/studio-apps'), respond: () => okJson({ error: 'nope' }, 404) }]);
    const result = await menus.syncStudioAppMenus();
    assert.deepStrictEqual(result, { ok: true, skipped: 'server_without_endpoint' });
});

// ── Push vs. poll: a push is never dropped ───────────────────────────

/** A SaaS list handler whose reply is held until the test releases it. */
function heldListHandler(apps) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return {
        handler: {
            match: (u, c) => u.includes('/api/nextcloud/studio-apps') && c.method === 'GET',
            respond: async () => { await gate; return okJson({ apps }); },
        },
        release,
    };
}

test('requestSync during an in-flight pass runs ONE follow-up pass, shared by every push that arrives meanwhile', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    config.tenantKey = 'tk-secret';
    config.ncInstanceId = 'nc-instance-a';
    t.after(() => { config.tenantKey = null; config.ncInstanceId = null; });

    // Start from a clean slate so the counts below are exact.
    mockFetch([saasListHandler([]), ocsHandler]);
    await menus.syncStudioAppMenus();

    const held = heldListHandler([]);
    const calls = mockFetch([held.handler, ocsHandler]);
    const listFetches = () => calls.filter(c => c.url.includes('/api/nextcloud/studio-apps')).length;

    // The poller starts a pass and blocks on the SaaS.
    const poll = menus.syncStudioAppMenus();
    assert.strictEqual(listFetches(), 1);

    // The poller's own contract is unchanged: busy → skip, do not queue.
    assert.deepStrictEqual(await menus.syncStudioAppMenus(), { ok: true, skipped: 'in_flight' });

    // Two pushes land while it is blocked. Neither is skipped, and they share
    // ONE follow-up rather than queueing a pass each.
    const push1 = menus.requestSync();
    const push2 = menus.requestSync();
    assert.strictEqual(push1, push2, 'concurrent pushes share the follow-up promise');
    assert.strictEqual(listFetches(), 1, 'the follow-up waits for the running pass');

    held.release();
    const [pollResult, pushResult] = await Promise.all([poll, push1]);
    assert.strictEqual(pollResult.ok, true);
    assert.strictEqual(pushResult.ok, true);
    assert.strictEqual(pushResult.skipped, undefined, 'a push is never answered with in_flight');
    assert.strictEqual(listFetches(), 2, 'exactly one follow-up pass ran');

    // Idle again: a push simply runs a pass.
    await menus.requestSync();
    assert.strictEqual(listFetches(), 3);
});
