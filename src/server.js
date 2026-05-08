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

app.use(appApiAuthMiddleware);

registerLifecycle(app);

app.use('/api', buildApiProxy());

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

// Inline app icon for the Nextcloud top-menu entry. Tiny SVG so it embeds
// cleanly in the navbar; replace with branded asset later.
app.get('/img/app.svg', (_req, res) => {
    res.type('image/svg+xml').send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' +
        '<path d="M12 2L3 7v6c0 5 3.8 9.7 9 11 5.2-1.3 9-6 9-11V7l-9-5zm0 4l6 3v4c0 3.3-2.5 6.6-6 7.5-3.5-.9-6-4.2-6-7.5V9l6-3z"/>' +
        '</svg>'
    );
});

// Static SPA — built by the agent-hub package and copied into /public at
// container build time (see Dockerfile). Falls through to index.html for
// client-side routing.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false, fallthrough: true }));
app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(config.appPort, config.appHost, () => {
    console.log(`[BeeFlowConnector] ${config.appId} v${config.appVersion} listening on ${config.appHost}:${config.appPort}`);
    console.log(`[BeeFlowConnector] SaaS target: ${config.apiBaseUrl}`);
    console.log(`[BeeFlowConnector] Nextcloud:   ${config.nextcloudUrl}`);
});
