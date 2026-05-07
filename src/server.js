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
