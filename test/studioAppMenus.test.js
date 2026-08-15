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
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-menus-'));

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const config = require('../src/config');
const menus = require('../src/studioAppMenus');

const UUID = '4c6cbdcf-6a7e-4d9b-9f6e-2f1f5c1d0a01';
const NAME = 'sa_4c6cbdcf6a7e4d9b9f6e2f1f5c1d0a01';

// ── Name mapping ────────────────────────────────────────────────────

test('menu names round-trip crypto.randomUUID() app ids', () => {
    assert.strictEqual(menus.menuNameForAppId(UUID), NAME);
    assert.strictEqual(menus.appIdForMenuName(NAME), UUID);
    // Anything that cannot round-trip is refused, not mangled.
    assert.strictEqual(menus.menuNameForAppId('not-a-uuid'), null);
    assert.strictEqual(menus.appIdForMenuName('sa_zz'), null);
    assert.strictEqual(menus.appIdForMenuName('main'), null);
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
    // eslint-disable-next-line no-new-func
    new Function('document', 'OC', 'window', 'setTimeout', 'ResizeObserver', script)(
        sandbox.document, sandbox.OC, sandbox.window, sandbox.setTimeout, sandbox.ResizeObserver,
    );
    return { iframe, content };
}

test('the page script derives the app id from the entry name and mounts the proxied run view', () => {
    const { iframe, content } = runEmbedScript(`/index.php/apps/app_api/embedded/bee_flow/${NAME}`);
    assert.strictEqual(content.children.length, 1, 'exactly one iframe mounted');
    assert.strictEqual(
        iframe.src,
        `/index.php/apps/app_api/proxy/${config.appId}/?ncStudioApp=${UUID}`,
    );
    assert.match(iframe.allow, /clipboard-read; clipboard-write/);
    // Same measured-height contract as the main embed script.
    assert.strictEqual(iframe.style.height, '850px');
});

test('an unrecognisable entry name renders an error, never a guessed iframe', () => {
    const { content } = runEmbedScript('/index.php/apps/app_api/embedded/bee_flow/not_an_app');
    assert.strictEqual(content.children.length, 0);
    assert.match(content.textContent, /could not be loaded/);
});

// ── Menu icons ──────────────────────────────────────────────────────

test('entry icons are monochrome letter glyphs with XML-safe content', () => {
    assert.match(menus.buildEntryIconSvg('Quote intake'), />Q<\/text>/);
    // Leading punctuation is skipped for the first real letter/digit.
    assert.match(menus.buildEntryIconSvg('  "42 things"'), />4<\/text>/);
    // XML metacharacters cannot break out of the text node.
    assert.ok(!menus.buildEntryIconSvg('<script>').includes('><<'));
    assert.match(menus.buildEntryIconSvg(null), />•<\/text>/);
    // NC recolors menu icons via CSS filters — the glyph must be plain black.
    const svg = menus.buildEntryIconSvg('Zebra');
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
