/**
 * Bee Flow Nextcloud connector — entrypoint.
 *
 * Wires together:
 *   1. /heartbeat /init /enabled — ExApp lifecycle (unauthenticated heartbeat)
 *   2. /api/* — authenticated forward proxy to the Bee Flow SaaS
 *   3. /* — static React SPA served from /public
 *
 * Auth middleware sits between (1) and (2). /heartbeat is exempted inside
 * the middleware itself, so the order of registration here is just:
 *   express → security headers → cross-site gate → signed routes → auth →
 *   body parsing → lifecycle + api + static
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const serverChoice = require('./serverChoice');
const setupConfig = require('./setupConfig');

// Which Bee Flow server this install talks to, before anything else runs: the
// env lock, an existing binding or a saved choice, else none. With none the
// connector sends nothing to any Bee Flow server until an administrator
// chooses one (serverChoice.js).
const stored = setupConfig.init(config.persistentStorage);
serverChoice.applyAtBoot(config, stored);

const { appApiAuthMiddleware } = require('./auth');
const { securityHeaders, rejectCrossSiteWrites } = require('./security');
const { registerLifecycle } = require('./heartbeat');
const { buildApiProxy, buildEmbedProxy, isSpaShellPath, RUNTIME_SETTINGS_PATH } = require('./proxy');
const log = require('./log');
const { errMessage, withoutFinalStop } = require('./errors');
const { withNonceRoom } = require('./htmlPadding');

// Apply the Nextcloud TLS posture decided at boot (scripts/ncTlsTrust.js) BEFORE
// any NC-bound fetch runs. No-op when the NC cert is publicly trusted; otherwise
// installs an origin-scoped dispatcher that trusts the Nextcloud origin only
// (the Bee Flow server channel and all other TLS stay verified). See ncTls.js.
require('./ncTls').installNcDispatcher();

const app = express();

// Response hardening: `frame-ancestors` limited to this Nextcloud's own
// origins (so the embedded SPA renders, and nothing else can frame it),
// plus nosniff / no-referrer / noindex. See security.js for why the previous
// "echo whatever Origin/Referer the request carried" approach was the bug it
// was meant to prevent.
app.use(securityHeaders);

// Nextcloud's AppAPI proxy controller is #[NoCSRFRequired], so no CSRF check
// happens upstream of us. This rejects state-changing requests that the
// browser itself reports as coming from another site.
app.use(rejectCrossSiteWrites);

// Mount /nc/* reverse-proxy before the AppAPI auth gate. Calls under /nc
// originate from the Bee Flow SaaS (not from a browser via NC's signed
// proxy), so they don't carry an AUTHORIZATION-APP-API header. They are
// authenticated via HMAC-signed `X-Beeflow-Sig` against the tenant key —
// see ncProxy.js verifyHmac.
require('./ncProxy').mount(app);

// Nextcloud's `webhook_listeners` background job calls /hooks/nextcloud with
// no user session, so it must also sit before the AppAPI auth gate. It is
// authenticated by the `X-Beeflow-Hook-Secret` header that Nextcloud echoes
// back from the `authData` we supplied at registration — see
// automationEventsWebhook.js and webhookListeners.js.
app.use('/', require('./automationEventsWebhook'));

// Nextcloud Talk calls the bot route with no user session and its own
// signature scheme, so it too sits before the AppAPI gate.
app.use('/', require('./talkBot'));

// The Bee Flow SaaS pushes "re-sync the app menu now" here the moment an owner
// toggles "Show in the Nextcloud app menu". Same caller and same tenant-key
// HMAC as /nc/*, so it sits before the AppAPI gate too — and before the SaaS
// catch-all proxy below, which would otherwise bounce the call back to the
// SaaS that made it.
require('./studioAppMenus').mountPushHook(app);

app.use(appApiAuthMiddleware);

// Body parsing sits AFTER the auth gate on purpose. Every route reached before
// this point brings its own parser with a limit sized for what it actually
// receives (raw bytes for /nc/*, 256 kB for the Talk bot, 512 kB for webhook
// deliveries), so parsing here first only meant an unauthenticated caller could
// make the connector buffer and parse 25 MB of JSON before anything checked who
// they were.
//
// /nc/* stays excluded regardless: it is a byte-for-byte reverse proxy into
// Nextcloud, and parsing and re-serialising a body there corrupts JSON file
// uploads (key order and whitespace are lost), rejects syntactically-invalid
// .json files with a 400 before they reach WebDAV, and imposes the 25 MB limit
// on every DAV write.
const jsonParser = express.json({ limit: '25mb' });
app.use((req, res, next) => {
    if (req.path === '/nc' || req.path.startsWith('/nc/')) return next();
    return jsonParser(req, res, next);
});

// Legacy user/group sync bridge. Nextcloud's User/Group events are not
// `IWebhookCompatibleEvent`, so nothing subscribes to this today; the route is
// kept so an internal caller (or a future Nextcloud that makes those events
// webhook-compatible) still has somewhere to deliver to. Real-time user sync
// currently comes from the periodic backstop and the manual "Sync now" action.
app.use('/', require('./eventsWebhook'));

// User-facing setup picker — choose Bee Flow Cloud vs a self-hosted server.
// Routes auth-checked by appApiAuthMiddleware above (admin only via NC). The
// server itself was resolved at the top of this file.
// Admin-supplied public NC URL — only used when no install-time value fixes
// it: a usable BEEFLOW_NC_PUBLIC_URL wins, then the saved value, then
// NEXTCLOUD_URL.
if (stored && !config.nextcloudPublicUrlLocked && stored.publicNcUrl) {
    config.nextcloudPublicUrl = stored.publicNcUrl;
    log.info(`[Setup] applying user-chosen publicNcUrl: ${config.nextcloudPublicUrl}`);
}
app.use('/setup', require('./setup'));

registerLifecycle(app);

// POST /trigger — Nextcloud calls this (AppAPI's ITriggerableProvider shim,
// default verb POST) when a Task Processing task is scheduled for one of our
// providers. Registered after the AppAPI gate: unlike the webhook and Talk
// routes, this one IS an authenticated AppAPI call — a service-level one with
// an empty userId, which auth.js allow-lists in SERVICE_PATHS.
require('./taskProcessing').registerRoutes(app);

// POST /files-action — Nextcloud's Files plugin calls this when a user picks a
// Bee Flow entry from the right-click menu. Behind the AppAPI gate: it is a
// user action and must carry their identity.
require('./filesActions').registerRoutes(app);

// While no Bee Flow server is chosen, everything below this line is closed: a
// page load gets the setup page in first-run mode (the picker for an
// administrator, a short notice for everybody else), and nothing is proxied or
// fetched from a Bee Flow host. The routes above stay open because Nextcloud
// and the setup page need them, and none of them contacts a Bee Flow server
// without a tenant key, which does not exist without a server. The page is
// read once, here.
const SETUP_HTML_PATH = path.join(__dirname, 'setup.html');
/** @type {string | null} */
let setupHtml = null;
try {
    setupHtml = fs.readFileSync(SETUP_HTML_PATH, 'utf8');
} catch (err) {
    log.error(`[Boot] setup.html could not be read: ${errMessage(err)}`);
}
app.use(serverChoice.unconfiguredGate({ pageHtml: () => setupHtml }));

// A server is chosen, connecting to it failed and there is no key: a page load
// gets the setup page too (the failure and its remedy for an administrator, a
// short notice for everybody else) until the connection is made.
app.use(serverChoice.connectFailedGate({
    pageHtml: () => setupHtml,
    connectFailed: () => require('./bootstrap').connectFailed(),
}));

// A Nextcloud account without an e-mail address cannot sign in to Bee Flow:
// the web app and the calls it proxies answer with a clear message. Everything
// mounted above (setup, diagnostics, lifecycle) works without an address.
app.use(require('./noEmail').noEmailGate);

// Re-run UI registration (top-menu, embed script, settings form, event
// listeners) on every boot. AppAPI only calls /init on install/upgrade, so
// without this a `docker restart` after the script's re-registration step
// (which DELETEs oc_ex_ui_top_menu) leaves the bee icon missing from the
// NC top bar. Each underlying OCS call accepts HTTP 409 (already
// registered) silently, so this is safe to re-run on a healthy install too.
const { runInitInBackground } = require('./heartbeat');
setImmediate(() => {
    runInitInBackground().catch(err => {
        log.warn(`[Boot] UI re-registration failed (non-fatal): ${errMessage(err)}`);
    });
});

// @nextcloud/l10n bundled into the SPA pings these endpoints on every page
// load to fetch translations from a "real" NC instance. The Bee Flow server
// doesn't host them — forwarding produces 404 spam in the console. Return
// an empty translation table so the lib falls back to English silently.
app.get(['/api/languages/user/locales', '/api/languages/user/strings/:lang',
        '/api/languages/public/strings/:lang'], (_req, res) => {
    res.json({ translations: {}, pluralForm: 'nplurals=2; plural=(n != 1);' });
});

// Forward to SaaS by default. The deny-list below covers everything the
// connector serves itself (lifecycle, static assets, SPA shell). Anything
// else lands on the SaaS — that includes >50 backend mounts (`/auth`,
// `/agents`, `/automation`, `/integrations`, `/api/*` sub-routes, etc.).
// A maintained allow-list drifted as new endpoints were added; the deny-
// list captures the small, stable set of connector-owned paths instead.
// `app-icon.svg` is the favicon the shell's own index.html links to. It was
// absent here, so it fell through to the SaaS API proxy and 404'd on every
// embedded page load.
// The SPA shell paths come from proxy.js's isSpaShellPath, so a folder the
// frontend build adds (/monaco, /fonts, /module-shims) is listed once: here it
// once had its own copy of the list, and a path missing from it went to the
// SaaS API proxy and 404'd.
const CONNECTOR_SETUP = /^\/setup(\/|$)/;
/** @param {string} urlPath */
const isConnectorOwned = (urlPath) => CONNECTOR_SETUP.test(urlPath) || isSpaShellPath(urlPath);
const proxy = buildApiProxy();
app.use((req, res, next) => {
    if (isConnectorOwned(req.url.split('?')[0])) return next();
    return proxy(req, res, next);
});

// JS that NC injects into the embedded ExApp page. It builds an iframe
// pointing at NC's signed proxy back to this connector, which lets the
// SPA render inside the Nextcloud chrome.
app.get(['/js/embed', '/js/embed.js'], (_req, res) => {
    // Deployment-aware frame target.
    //
    //   AppAPI proxy (/apps/app_api/proxy/<appId>/) — every byte, including
    //   each SSE chat stream, is passed through PHP by ExAppProxyController
    //   (synchronous Guzzle + fpassthru, RequestOptions::TIMEOUT => 0). One
    //   open stream therefore occupies one PHP-FPM worker for its entire
    //   lifetime, so a few dozen concurrent chats can exhaust the pool and
    //   take the whole Nextcloud down with them.
    //
    //   HaRP (/exapps/<appId>/) — HaRP routes straight to this container,
    //   so streams never enter the PHP pool at all. HP_SHARED_KEY is what
    //   AppAPI injects for HaRP deployments, and it is what server.js
    //   already keys its unix-socket bind on, so it is the mode signal.
    //
    // The SPA reads its own prefix from the document URL at runtime
    // (agent-hub utils/helpers.js deriveEmbedApiBase), so one bundle serves
    // both shapes. Assets still resolve through the baked AppAPI base for
    // now — they are cacheable and idle, unlike streams.
    //
    // The AppAPI path ends in `index.html`, not `/`. AppAPI decides whether a
    // proxied response is HTML with
    // `pathinfo($other, PATHINFO_EXTENSION) === 'html'`, and only HTML gets
    // its `<script` tags rewritten to carry Nextcloud's CSP nonce. Framing the
    // bare `/` therefore served the shell WITHOUT a nonce, so Nextcloud's own
    // CSP blocked both of the shell's inline scripts — the import map and the
    // pre-React theme bootstrap — in the embed and nowhere else. Naming
    // index.html restores the nonce injection; `^/?index\.html$` is already a
    // PUBLIC route and the shell proxy already serves that path.
    //
    // HaRP needs no such trick: it never passes through PHP, so no nonce is
    // involved and the connector's own CSP (frame-ancestors only) governs.
    const framePath = process.env.HP_SHARED_KEY
        ? `/exapps/${config.appId}/`
        : `/apps/app_api/proxy/${config.appId}/index.html`;
    res.type('application/javascript').send(`
(function() {
    var content = document.getElementById('content');
    if (!content) return;
    content.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = OC.generateUrl('${framePath}');
    // Deep link: a mail link such as .../embedded/bee_flow/main?path=/app/projects/p1
    // opens that screen inside the frame. Only a relative in-app path passes
    // (no scheme, no '//', no '..'); the SPA reads it once as ?ncPath=
    // (agent-hub utils/ncDeepLink.ts). Works for both frame targets.
    try {
        var want = new URLSearchParams(window.location.search).get('path');
        if (want && want.indexOf('/app/') === 0 && /^[-A-Za-z0-9/_?=&.%]+$/.test(want)
            && want.indexOf('//') < 0 && want.indexOf('..') < 0) {
            iframe.src += '?ncPath=' + encodeURIComponent(want);
        }
    } catch (e) { /* no deep link: land on the home screen */ }
    // Height was hardcoded to calc(100vh - 50px), i.e. an assumption that
    // Nextcloud's chrome above #content is exactly 50px. It is not, and the
    // difference is paid by the BOTTOM of the frame — which is where the chat
    // composer lives. Measured against real NC shells the frame overshot its
    // slot by 4-44px (body gap in NC 28+, taller header under browser zoom, an
    // app-navigation row), clipping the input box out of view; users read that
    // as "I can't send a message".
    //
    // Measure the frame's own top offset instead of guessing it, and re-measure
    // on resize so zoom and orientation changes stay correct.
    iframe.style.cssText = 'width:100%;border:0;display:block;';
    iframe.allow = 'clipboard-read; clipboard-write';
    content.appendChild(iframe);

    function fit() {
        var top = iframe.getBoundingClientRect().top;
        // Clamp: a mid-layout measurement can briefly read past the viewport.
        var h = Math.max(320, Math.round(window.innerHeight - top));
        iframe.style.height = h + 'px';
    }
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    // NC's own chrome settles after our script runs (app menu, banners), so
    // re-measure once the layout has quiesced.
    if (typeof ResizeObserver === 'function') {
        try { new ResizeObserver(fit).observe(content); } catch (e) { /* older browsers */ }
    }
    setTimeout(fit, 0);
    setTimeout(fit, 250);
})();
`);
});

// Studio-app menu entries: /js/embed-app (the per-entry page script) and
// /img/studio-app/<name>.svg (per-entry menu icons). Registered HERE — after
// the SaaS-proxy gate (isConnectorOwned already excludes /js/ and /img/) and
// before the embed-shell proxy, which would otherwise forward these paths to
// the cloud /embed/ build and 404. The sync loop that registers the entries
// with AppAPI runs from heartbeat.js (/init) and the poller below.
const studioAppMenus = require('./studioAppMenus');
studioAppMenus.registerRoutes(app);
studioAppMenus.startPolling();

// The SPA bundle baked into /public at container build time (see Dockerfile).
// As of the embed-proxy change this is the OFFLINE FALLBACK only — the primary
// path proxies the shell from the cloud `/embed/` build (below), so a frontend
// deploy reaches the embedded view without a connector release.
const publicDir = path.join(__dirname, '..', 'public');

// Bee Flow icon for the Nextcloud top-menu entry. Shipped as a verbatim
// public asset (agent-hub/public/app-icon.svg) so it lands at the bundle
// root with a stable name — the SPA's own logo lives in src/assets/ and
// is import-hashed by Vite. Keeping the two copies separate stops SPA
// developers from accidentally referencing the public path as a string
// literal (which would 404 inside the NC iframe).
app.get('/img/app.svg', (_req, res) => {
    const logoPath = path.join(publicDir, 'app-icon.svg');
    fs.access(logoPath, fs.constants.R_OK, (err) => {
        if (err) {
            // Fallback to an inline shield if the bundled logo is missing
            // (shouldn't happen with a normal build, but keeps the navbar
            // icon non-blank rather than 404).
            res.type('image/svg+xml').send(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' +
                '<path d="M12 2L3 7v6c0 5 3.8 9.7 9 11 5.2-1.3 9-6 9-11V7l-9-5zm0 4l6 3v4c0 3.3-2.5 6.6-6 7.5-3.5-.9-6-4.2-6-7.5V9l6-3z"/>' +
                '</svg>'
            );
            return;
        }
        res.type('image/svg+xml');
        fs.createReadStream(logoPath).pipe(res);
    });
});
// SPA SHELL → proxy to the cloud `/embed/` build (always-fresh), with the
// baked /public as fallback. SPA_SHELL is the bundle subset of the connector-
// owned paths; the connector-LOCAL routes (/setup, /js/embed, /img/app.svg)
// were already handled above, so they never reach here. Client-side routes
// (e.g. /agents) are NOT in SPA_SHELL and stay proxied to the SaaS API by the
// gate above — unchanged. On embed-proxy error the handler invokes the
// stashed req.__shellNext, falling through to express.static(/public) and the
// baked index.html catch-all below.
//
// Edge: if the cloud flaps mid-page-load (index.html from cloud, a later asset
// falls back to a different baked hash → 404), a reload recovers.
const embedProxy = buildEmbedProxy();
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isSpaShellPath(req.url)) return next();
    req.__shellNext = next;
    return embedProxy(req, res, next);
});
// The web app's runtime settings script, when the shell host above has none
// (the copy built into this image, or a web app that does not publish one): an
// empty script, which the web app reads as "no runtime settings".
app.get(RUNTIME_SETTINGS_PATH, (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('application/javascript').send('/* no runtime settings */\n');
});
const indexHtmlPath = path.join(publicDir, 'index.html');
// The shell baked into this image, asked for as `/index.html` (the path the
// Nextcloud top bar frames on a manual-install daemon): sent with room for the
// nonce Nextcloud adds to its script tags, see htmlPadding.js.
app.get('/index.html', (_req, res, next) => {
    fs.readFile(indexHtmlPath, 'utf8', (err, html) => {
        if (err) return next();
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.type('html').send(withNonceRoom(html));
    });
});
app.use(express.static(publicDir, { index: false, fallthrough: true }));

// SPA is built with --base and VITE_API_URL pointing at the NC proxy path,
// so all asset URLs (in index.html) and runtime API calls
// (`${API_BASE}/auth/...`) already include the proxy prefix. No HTML
// rewriting needed — just serve index.html for client-side routes.
//
// Force no-store on index.html: it carries the hashed asset reference,
// so a stale copy in browser/NC-proxy disk cache pins users to an old
// SPA bundle. Hashed assets under /assets/ keep their long-cache.
app.get('/{*splat}', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(indexHtmlPath);
});

// A handler that threw: a plain 500, the detail in the log only.
app.use(require('./httpGuards').terminalErrorHandler);

// One-shot auto-bootstrap on the chosen Bee Flow server: load the cached
// binding, or provision an org + tenant key. Runs in the background so the
// connector keeps serving heartbeats even if the server is briefly
// unreachable. A failure is logged and recorded for the setup page; one that
// can pass by itself is tried again (bootstrap.js). A no-op while no server is
// chosen.
const { bootstrapIfNeeded } = require('./bootstrap');
bootstrapIfNeeded().catch(err => {
    // While the connector cannot read Nextcloud, Nextcloud's user lookup fails
    // too and the setup page does not open: the log line then names where the
    // cause can be read.
    const where = require('./bootstrap').getLastErrorState()?.phase === 'capabilities'
        ? 'The line above names the cause; what to do is in bootstrap-last-error.json on the data volume and in the heartbeat Nextcloud asks for.'
        : 'The Bee Flow setup page has the cause and what to do.';
    log.error(`[Bootstrap] Failed: ${withoutFinalStop(errMessage(err))}. ${where}`);
});

// NC admin settings panel (Cloud vs self-hosted) — poll for changes every
// 60s and apply to the live config. Started on every boot rather than only
// on /init, since NC only calls /init on install/upgrade. Its first read
// follows the bootstrap above.
require('./declarativeSettings').startPolling();

// HaRP-compatible: when HP_SHARED_KEY is set (HaRP daemon mode), bind to a
// Unix domain socket that frpc tunnels back to HaRP. Otherwise bind TCP for
// manual-install / direct access.
if (process.env.HP_SHARED_KEY) {
    const sockPath = '/tmp/exapp.sock';
    try { fs.unlinkSync(sockPath); } catch (_) { /* socket may not exist yet */ }
    app.listen(sockPath, () => {
        try { fs.chmodSync(sockPath, 0o660); } catch (_) {}
        log.info(`[BeeFlowConnector] ${config.appId} v${config.appVersion} listening on unix:${sockPath} (HaRP mode)`);
        log.info(`[BeeFlowConnector] Bee Flow server: ${config.apiBaseUrl || '(not chosen)'}`);
        log.info(`[BeeFlowConnector] Nextcloud:   ${config.nextcloudUrl}`);
    });
} else {
    app.listen(config.appPort, config.appHost, () => {
        log.info(`[BeeFlowConnector] ${config.appId} v${config.appVersion} listening on ${config.appHost}:${config.appPort}`);
        log.info(`[BeeFlowConnector] Bee Flow server: ${config.apiBaseUrl || '(not chosen)'}`);
        log.info(`[BeeFlowConnector] Nextcloud:   ${config.nextcloudUrl}`);
    });
}

// A stop is not an uninstall: exit without unregistering anything (see
// shutdown.js for what the old teardown did to the Talk bot).
const gracefulShutdown = require('./shutdown').createShutdownHandler();
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
