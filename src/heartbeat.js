/**
 * ExApp lifecycle endpoints.
 *
 * Contract: https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 *   GET  /heartbeat     — unauthenticated, must respond within 10 min of start
 *   POST /init          — authenticated, optional setup; report progress 1-100
 *   PUT  /enabled?...   — authenticated, registers/unregisters NC-side hooks
 */

const config = require('./config');

function registerLifecycle(app) {
    app.get('/heartbeat', (req, res) => {
        res.json({ status: 'ok' });
    });

    // /init runs once per install. We use it to verify the SaaS is reachable
    // with the configured tenant key — fail fast at install time rather than
    // on the user's first click. AppAPI expects progress reports to
    // /ocs/v2.php/apps/app_api/ex-app/status; we report 100 immediately
    // because there's no model download or migration to run.
    app.post('/init', async (req, res) => {
        try {
            const probeUrl = `${config.apiBaseUrl}/api/health`;
            const probe = await fetch(probeUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(15_000),
            });
            if (!probe.ok) {
                return res.status(502).json({
                    error: `Bee Flow service unreachable: HTTP ${probe.status}`,
                });
            }
            await reportInitProgress(100).catch(err => {
                console.warn(`[Init] Progress report failed (non-fatal): ${err.message}`);
            });
            res.json({ status: 'ok' });
        } catch (err) {
            console.error(`[Init] Failed: ${err.message}`);
            res.status(502).json({ error: err.message });
        }
    });

    app.put('/enabled', (req, res) => {
        const enabled = req.query.enabled === '1';
        console.log(`[Lifecycle] enabled=${enabled}`);
        // Future: register/unregister navigation entry, dashboard widget, etc.
        // For v0.1.0 the navigation entry is declared statically in info.xml.
        res.json({ status: 'ok' });
    });
}

async function reportInitProgress(percent) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/apps/app_api/ex-app/status`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'OCS-APIRequest': 'true',
            'EX-APP-ID': config.appId,
            'EX-APP-VERSION': config.appVersion,
            'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
        },
        body: JSON.stringify({ progress: percent }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new Error(`Status report failed: HTTP ${res.status}`);
    }
}

module.exports = { registerLifecycle };
