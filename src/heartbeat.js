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

    // /init runs once per install. We do a best-effort SaaS probe so the
    // admin sees a warning if upstream is unreachable, but install never
    // fails on it — a transient SaaS outage shouldn't block the connector
    // from coming up. AppAPI expects progress on
    // /ocs/v2.php/apps/app_api/ex-app/status; we report 100 immediately
    // because there's no model download or migration to run on our side.
    app.post('/init', async (req, res) => {
        try {
            const probe = await fetch(`${config.apiBaseUrl}/api/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(5_000),
            });
            if (!probe.ok) {
                console.warn(`[Init] SaaS health probe returned HTTP ${probe.status} — continuing`);
            }
        } catch (err) {
            console.warn(`[Init] SaaS health probe failed (non-fatal): ${err.message}`);
        }
        await reportInitProgress(100).catch(err => {
            console.warn(`[Init] Progress report failed (non-fatal): ${err.message}`);
        });
        res.json({ status: 'ok' });
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
