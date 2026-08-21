/**
 * The embed script Nextcloud injects into its ExApp page.
 *
 * It builds the iframe that hosts the Bee Flow SPA. Its height used to be
 * `calc(100vh - 50px)` — a hardcoded guess at how much chrome sits above
 * #content. Whatever that guess gets wrong is paid at the BOTTOM of the frame,
 * which is where the chat composer lives: measured against real Nextcloud shells
 * the frame overshot its slot by 4-44px (the body gap in NC 28+, a taller header
 * under browser zoom, an app-navigation row), clipping the input box out of view.
 * Users report that as "I can't send a message".
 */
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Read the served script out of the source rather than booting the whole app
// (server.js binds a port and kicks off bootstrap on require).
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const embedRoute = SERVER_JS.slice(
    SERVER_JS.indexOf("app.get(['/js/embed'"),
    SERVER_JS.indexOf('const publicDir'),
);

test('the iframe height is measured, not a hardcoded viewport guess', () => {
    assert.ok(
        !/height:\s*calc\(100vh\s*-\s*\d+px\)/.test(embedRoute),
        'hardcoding the chrome height clips the composer whenever the guess is wrong',
    );
    assert.match(embedRoute, /getBoundingClientRect\(\)\.top/,
        'the frame must measure its own offset');
    assert.match(embedRoute, /window\.innerHeight\s*-\s*top/,
        'height must be derived from the measured offset');
});

test('the height is recomputed when the viewport changes', () => {
    assert.match(embedRoute, /addEventListener\('resize'/);
    assert.match(embedRoute, /addEventListener\('orientationchange'/);
});

test('the height is recomputed after Nextcloud settles its own chrome', () => {
    assert.ok(
        /ResizeObserver/.test(embedRoute) || /setTimeout\(\s*fit/.test(embedRoute),
        'NC renders its app menu/banners after our script runs, so one measurement is not enough',
    );
});

test('a degenerate measurement cannot collapse the frame', () => {
    assert.match(embedRoute, /Math\.max\(\s*\d+/,
        'a mid-layout read can land past the viewport; clamp to a usable minimum');
});

test('the iframe points at a connector-owned route and keeps clipboard access', () => {
    // The target became deployment-dependent (AppAPI proxy vs HaRP /exapps/ —
    // see the per-mode tests at the bottom of this file); what must not drift
    // is that both targets are ours and that clipboard access survives.
    assert.match(embedRoute, /const framePath = process\.env\.HP_SHARED_KEY/);
    assert.match(embedRoute, /clipboard-read; clipboard-write/);
});

// Executable check of the sizing logic itself: run the generated script against
// a minimal DOM and assert the frame ends exactly at the viewport bottom for a
// range of Nextcloud chrome heights — including the ones the old constant got
// wrong.
test('the computed height fits the frame to its slot for any chrome height', () => {
    const body = embedRoute.slice(embedRoute.indexOf('(function()'), embedRoute.lastIndexOf('})();') + 5);
    const script = body.replace(/\$\{config\.appId\}/g, 'bee_flow');

    for (const chromeTop of [50, 54, 58, 94, 120]) {
        const viewportHeight = 1115;
        const iframe = { style: { cssText: '', height: '' }, getBoundingClientRect: () => ({ top: chromeTop }) };
        const listeners = {};
        const sandbox = {
            document: {
                getElementById: () => ({ innerHTML: '', appendChild() {} }),
                createElement: () => iframe,
            },
            OC: { generateUrl: (p) => p },
            window: {
                innerHeight: viewportHeight,
                addEventListener: (evt, fn) => { listeners[evt] = fn; },
            },
            setTimeout: () => {},
            ResizeObserver: undefined,
        };
        // eslint-disable-next-line no-new-func
        new Function('document', 'OC', 'window', 'setTimeout', 'ResizeObserver', script)(
            sandbox.document, sandbox.OC, sandbox.window, sandbox.setTimeout, sandbox.ResizeObserver,
        );

        const height = parseInt(iframe.style.height, 10);
        assert.equal(
            chromeTop + height, viewportHeight,
            `chrome ${chromeTop}px: frame ends at ${chromeTop + height}, viewport is ${viewportHeight} — `
            + 'the composer is clipped by the difference',
        );
    }
});

// ── Deployment-aware frame target ───────────────────────────────────────────
// AppAPI's PHP proxy passes every byte through PHP-FPM with no timeout
// (ExAppProxyController: Guzzle + fpassthru, RequestOptions::TIMEOUT => 0), so
// one open SSE chat stream holds one worker for its whole lifetime and enough
// concurrent chats exhaust the pool — taking Nextcloud, not just Bee Flow,
// down. HaRP's /exapps/ route reaches this container directly, so streams
// never enter the pool. HP_SHARED_KEY is the mode signal AppAPI injects, and
// the same one server.js keys its unix-socket bind on.

test('HaRP deployments frame the direct /exapps/ route', () => {
    assert.match(embedRoute, /HP_SHARED_KEY/,
        'the frame target must depend on the deployment mode');
    assert.match(embedRoute, /`\/exapps\/\$\{config\.appId\}\/`/,
        'HaRP mode must bypass the PHP proxy — that is the whole point of adopting HaRP');
});

test('non-HaRP deployments keep the AppAPI proxy route, and name index.html', () => {
    assert.match(embedRoute, /`\/apps\/app_api\/proxy\/\$\{config\.appId\}\/index\.html`/,
        'Docker-Socket-Proxy installs have no /exapps/ route — they must keep the proxy path. '
        + 'It must end in index.html: AppAPI injects Nextcloud\'s CSP nonce only into responses whose '
        + 'path has an .html extension (pathinfo(...) === \'html\'), and without the nonce Nextcloud\'s '
        + 'CSP blocks the shell\'s inline import map and theme bootstrap — in the embed only.');
});

test('the frame target is still resolved through OC.generateUrl', () => {
    // Nextcloud may live under a subdirectory; a hardcoded absolute path
    // would 404 on every such install.
    assert.match(embedRoute, /OC\.generateUrl\('\$\{framePath\}'\)/);
});
