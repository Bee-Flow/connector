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
 *   express → rawBody capture → auth → lifecycle + api + static
 */

const express = require('express');
const path = require('path');
const config = require('./config');
const { appApiAuthMiddleware } = require('./auth');
const { registerLifecycle } = require('./heartbeat');
const { buildApiProxy } = require('./proxy');

const app = express();

// Capture the raw body so the AppAPI signature can be verified against the
// exact bytes Nextcloud sent. express.json() consumes the stream, so we
// stash a copy via the `verify` hook before parsing happens.
app.use(express.json({
    limit: '25mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// CSP must allow the parent NC origin to embed proxied responses. Without
// this, NC's default CSP wraps our response with `frame-ancestors 'none'`
// and the browser blocks rendering. The connector knows NEXTCLOUD_URL but
// the user's browser may reach NC via a different origin (localhost vs
// host.docker.internal in dev, customer domain in prod). The forwarded
// request's Origin/Referer tells us what the browser sees.
app.use((req, res, next) => {
    const ancestors = new Set(["'self'", new URL(config.nextcloudUrl).origin]);
    for (const hdr of ['origin', 'referer']) {
        const v = req.headers[hdr];
        if (!v) continue;
        try { ancestors.add(new URL(v).origin); } catch { /* ignore malformed */ }
    }
    res.setHeader('Content-Security-Policy', `frame-ancestors ${[...ancestors].join(' ')}`);
    next();
});

// Mount /nc/* reverse-proxy before the AppAPI auth gate. Calls under /nc
// originate from the Bee Flow SaaS (not from a browser via NC's signed
// proxy), so they don't carry an AUTHORIZATION-APP-API header. They are
// authenticated via HMAC-signed `X-Beeflow-Sig` against the tenant key —
// see ncProxy.js verifyHmac.
require('./ncProxy').mount(app);

app.use(appApiAuthMiddleware);

// /webhook/nc-events is hit by NC's AppAPI events_listener with an
// AUTHORIZATION-APP-API header — appApiAuthMiddleware above has already
// validated the shared secret by the time we reach this router.
app.use('/', require('./eventsWebhook'));
app.use('/', require('./automationEventsWebhook'));

// User-facing setup picker — choose Bee Flow Cloud vs a self-hosted server.
// Routes auth-checked by appApiAuthMiddleware above (admin only via NC).
const setupConfig = require('./setupConfig');
const stored = setupConfig.init(config.persistentStorage);
if (stored && !process.env.BEEFLOW_API_BASE_URL && stored.apiBaseUrl) {
    config.apiBaseUrl = stored.apiBaseUrl;
    console.log(`[Setup] applying user-chosen apiBaseUrl: ${config.apiBaseUrl} (${stored.mode})`);
}
// Admin-supplied public NC URL — only used when the env override is unset.
// Same precedence rule as apiBaseUrl: env wins, then picker, then fallback.
if (stored && !process.env.BEEFLOW_NC_PUBLIC_URL && stored.publicNcUrl) {
    config.nextcloudPublicUrl = stored.publicNcUrl;
    console.log(`[Setup] applying user-chosen publicNcUrl: ${config.nextcloudPublicUrl}`);
}
app.use('/setup', require('./setup'));

// NC admin settings panel (Cloud vs self-hosted) — poll for changes every
// 60s and apply to the live config. Started on every boot rather than only
// on /init, since NC only calls /init on install/upgrade.
require('./declarativeSettings').startPolling();

registerLifecycle(app);

// Re-run UI registration (top-menu, embed script, settings form, event
// listeners) on every boot. AppAPI only calls /init on install/upgrade, so
// without this a `docker restart` after the script's re-registration step
// (which DELETEs oc_ex_ui_top_menu) leaves the bee icon missing from the
// NC top bar. Each underlying OCS call accepts HTTP 409 (already
// registered) silently, so this is safe to re-run on a healthy install too.
const { runInitInBackground } = require('./heartbeat');
setImmediate(() => {
    runInitInBackground().catch(err => {
        console.warn(`[Boot] UI re-registration failed (non-fatal): ${err.message}`);
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
const CONNECTOR_OWNED = /^\/(setup\/?(.*)?$|assets\/|js\/|img\/|favicon|BeeFlow-logo|bee-flow-logo|index\.html$|$)/;
const proxy = buildApiProxy();
app.use((req, res, next) => {
    if (CONNECTOR_OWNED.test(req.url.split('?')[0])) return next();
    return proxy(req, res, next);
});

// JS that NC injects into the embedded ExApp page. It builds an iframe
// pointing at NC's signed proxy back to this connector, which lets the
// SPA render inside the Nextcloud chrome.
app.get(['/js/embed', '/js/embed.js'], (_req, res) => {
    res.type('application/javascript').send(`
(function() {
    var content = document.getElementById('content');
    if (!content) return;
    content.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = OC.generateUrl('/apps/app_api/proxy/${config.appId}/');
    iframe.style.cssText = 'width:100%;height:calc(100vh - 50px);border:0;display:block;';
    iframe.allow = 'clipboard-read; clipboard-write';
    content.appendChild(iframe);
})();
`);
});

// Static SPA — built by the agent-hub package and copied into /public at
// container build time (see Dockerfile). Falls through to index.html for
// client-side routing.
const publicDir = path.join(__dirname, '..', 'public');

// Bee Flow icon for the Nextcloud top-menu entry — same asset the SPA uses
// in the folded sidebar (BeeFlow-logo-Icon-2026.svg) so users see one
// consistent brand mark across NC chrome and the embedded app.
app.get('/img/app.svg', (_req, res) => {
    const logoPath = path.join(publicDir, 'BeeFlow-logo-Icon-2026.svg');
    const fs3 = require('fs');
    fs3.access(logoPath, fs3.constants.R_OK, (err) => {
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
        fs3.createReadStream(logoPath).pipe(res);
    });
});
app.use(express.static(publicDir, { index: false, fallthrough: true }));

const indexHtmlPath = path.join(publicDir, 'index.html');
// SPA is built with --base and VITE_API_URL pointing at the NC proxy path,
// so all asset URLs (in index.html) and runtime API calls
// (`${API_BASE}/auth/...`) already include the proxy prefix. No HTML
// rewriting needed — just serve index.html for client-side routes.
//
// Force no-store on index.html: it carries the hashed asset reference,
// so a stale copy in browser/NC-proxy disk cache pins users to an old
// SPA bundle. Hashed assets under /assets/ keep their long-cache.
app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(indexHtmlPath);
});

// One-shot auto-bootstrap: provision a Bee Flow org + tenant key on first
// boot. Runs in the background so the connector keeps serving heartbeats
// even if the SaaS is briefly unreachable. Failures are logged and retried
// on the next /init lifecycle hit.
const { bootstrapIfNeeded } = require('./bootstrap');
bootstrapIfNeeded().catch(err => {
    console.error(`[Bootstrap] Failed: ${err.message}. Will retry on /init.`);
});

// HaRP-compatible: when HP_SHARED_KEY is set (HaRP daemon mode), bind to a
// Unix domain socket that frpc tunnels back to HaRP. Otherwise bind TCP for
// manual-install / direct access.
const fs2 = require('fs');
if (process.env.HP_SHARED_KEY) {
    const sockPath = '/tmp/exapp.sock';
    try { fs2.unlinkSync(sockPath); } catch (_) { /* socket may not exist yet */ }
    app.listen(sockPath, () => {
        try { fs2.chmodSync(sockPath, 0o660); } catch (_) {}
        console.log(`[BeeFlowConnector] ${config.appId} v${config.appVersion} listening on unix:${sockPath} (HaRP mode)`);
        console.log(`[BeeFlowConnector] SaaS target: ${config.apiBaseUrl}`);
        console.log(`[BeeFlowConnector] Nextcloud:   ${config.nextcloudUrl}`);
    });
} else {
    app.listen(config.appPort, config.appHost, () => {
        console.log(`[BeeFlowConnector] ${config.appId} v${config.appVersion} listening on ${config.appHost}:${config.appPort}`);
        console.log(`[BeeFlowConnector] SaaS target: ${config.apiBaseUrl}`);
        console.log(`[BeeFlowConnector] Nextcloud:   ${config.nextcloudUrl}`);
    });
}

// Best-effort unregister of NC event-listeners on shutdown so stale
// subscriptions don't accumulate after restarts. Re-registered on next
// /init by registerEventListeners().
let _shuttingDown = false;
async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`[BeeFlowConnector] ${signal} — unregistering NC event listeners`);
    try {
        const { unregisterEventListeners } = require('./heartbeat');
        await unregisterEventListeners();
    } catch (err) {
        console.warn(`[BeeFlowConnector] Unregister failed: ${err.message}`);
    }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
