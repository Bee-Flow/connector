/**
 * Setup endpoints — let the NC admin pick "Bee Flow Cloud" vs a self-hosted
 * server through a small built-in HTML page. No build step, no SPA bundle —
 * just a plain page served from this file so the picker works even before
 * the main SPA can reach a backend.
 *
 * Routes:
 *   GET  /setup           → setup.html
 *   GET  /setup/status    → current target + reachability hints
 *   POST /setup           → persist mode + apiBaseUrl, optionally trigger re-bootstrap
 *   POST /setup/test      → ping a candidate URL, return reachability summary
 *
 * All routes are admin-gated through AppAPI (same as /init). They do NOT
 * mint any tokens — at most they update the connector's effective config.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const setupConfig = require('./setupConfig');
const bootstrap = require('./bootstrap'); // for re-bootstrap on URL change

const router = express.Router();

const HTML_PATH = path.join(__dirname, 'setup.html');
const REQUEST_TIMEOUT_MS = 5_000;

/** Probe a Bee Flow service /api/health endpoint. */
async function probe(url) {
    const target = `${url.replace(/\/+$/, '')}/api/health`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(target, { signal: ac.signal });
        clearTimeout(t);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        return {
            ok: res.ok,
            status: res.status,
            url: target,
            version: body?.version || null,
            tier: body?.tier || null,
            error: res.ok ? null : `HTTP ${res.status}`,
        };
    } catch (err) {
        clearTimeout(t);
        return {
            ok: false,
            status: 0,
            url: target,
            error: err.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message,
        };
    }
}

router.get('/', (req, res) => {
    if (!fs.existsSync(HTML_PATH)) {
        return res.status(500).type('text/plain').send('setup.html missing — connector packaging error');
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(HTML_PATH);
});

router.get('/status', (req, res) => {
    const stored = setupConfig.get();
    res.json({
        envOverridden: !!process.env.BEEFLOW_API_BASE_URL,
        envApiBaseUrl: process.env.BEEFLOW_API_BASE_URL || null,
        active: config.apiBaseUrl,
        chosen: stored,
        cloudUrl: setupConfig.CLOUD_URL,
        defaults: {
            cloud: setupConfig.CLOUD_URL,
            selfHostedHint: 'http://bee-flow-server:3001',
            selfHostedLan: 'http://server.example.lan:3001',
        },
        // Public NC URL used by the SaaS for callbacks. Surfacing the
        // resolved value plus origin lets the picker UI decide what to
        // show: the env-fixed value is read-only; otherwise the field is
        // editable and we display the last-saved picker entry.
        publicNcUrl: {
            envOverridden: !!process.env.BEEFLOW_NC_PUBLIC_URL,
            envValue: process.env.BEEFLOW_NC_PUBLIC_URL || null,
            chosen: stored?.publicNcUrl || null,
            active: config.nextcloudPublicUrl || null,
            internalNcUrl: config.nextcloudUrl,
        },
    });
});

// Diagnostics — bootstrap state + actionable remediation for the SPA's
// error overlay and `app_api:app:heartbeat` operators. Admin-gated in
// info.xml because the response includes the active SaaS URL and the
// raw error message, both of which can leak internal-network shape.
router.get('/diagnostics', (req, res) => {
    let pending = null;
    let lastError = null;
    try {
        pending = bootstrap.getPendingState?.() || null;
        lastError = bootstrap.getLastErrorState?.() || null;
    } catch (_) { /* tolerate */ }

    const hasTenantKey = !!config.tenantKey;
    let state = 'ok';
    if (!hasTenantKey && pending && pending.status === 'pending') state = 'awaiting_admin_approval';
    else if (!hasTenantKey && lastError && lastError.status === 'failed') state = 'failed';
    else if (!hasTenantKey) state = 'initialising';

    res.json({
        state,
        hasTenantKey,
        apiBaseUrl: config.apiBaseUrl,
        organizationId: config.organizationId || null,
        ncInstanceId: config.ncInstanceId || null,
        pending: pending ? {
            pendingId: pending.pendingId,
            expiresAt: pending.expiresAt,
        } : null,
        lastError: lastError ? {
            category: lastError.category,
            phase: lastError.phase,
            error: lastError.error,
            remediation: bootstrap.remediationFor(lastError.category),
            lastAttemptAt: lastError.lastAttemptAt,
            nextRetryAt: lastError.nextRetryAt,
        } : null,
    });
});

router.post('/test', express.json(), async (req, res) => {
    const url = String(req.body?.apiBaseUrl || '').trim();
    if (!url) return res.status(400).json({ error: 'apiBaseUrl required' });
    const result = await probe(url);
    res.json(result);
});

// Admin-supplied public NC URL — used by the SaaS to call back into NC
// for ownership verification + runtime callbacks. Only needed when NC
// is behind NAT and BEEFLOW_NC_PUBLIC_URL wasn't set at deploy time.
// Empty body clears the override and falls back to NEXTCLOUD_URL.
router.post('/public-nc-url', express.json(), async (req, res) => {
    const url = String(req.body?.publicNcUrl || '').trim();
    if (url && !/^https?:\/\//.test(url)) {
        return res.status(400).json({ error: 'publicNcUrl must start with http:// or https://' });
    }
    let saved;
    try {
        saved = setupConfig.savePublicNcUrl(url || null);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    config.nextcloudPublicUrl = saved.publicNcUrl || null;

    // Drop the cached tenant key + retry bootstrap with the new public URL
    // so the admin sees a clear success/new error within ~5s instead of
    // restarting the container manually.
    if (typeof bootstrap.invalidateAndRebootstrap === 'function') {
        bootstrap.invalidateAndRebootstrap().catch(err => {
            console.warn('[Setup] public NC URL re-bootstrap failed (non-fatal):', err.message);
        });
    }

    res.json({ saved: { publicNcUrl: saved.publicNcUrl || null } });
});

router.post('/', express.json(), async (req, res) => {
    // Note: BEEFLOW_API_BASE_URL used to hard-lock this endpoint to whatever
    // value AppAPI env passed in. That made the in-NC settings panel
    // (declarativeSettings.js) read-only in the local sandbox, which always
    // sets the env var. The env now seeds the initial value via config.js
    // but admin overrides through this endpoint or the NC settings panel
    // win at runtime — last-writer wins, persisted via setupConfig.
    let { mode, apiBaseUrl } = req.body || {};
    if (mode === 'cloud') apiBaseUrl = setupConfig.CLOUD_URL;

    let saved;
    try {
        saved = setupConfig.save({ mode, apiBaseUrl });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    // Apply to the live process so the SPA sees it on the next API call —
    // saves a container restart for the typical change.
    config.apiBaseUrl = saved.apiBaseUrl;

    // If the SaaS target changed, the existing tenant key is for a different
    // service and must be discarded. Trigger a fresh bootstrap in the
    // background so the user can keep clicking through the SPA.
    if (typeof bootstrap.invalidateAndRebootstrap === 'function') {
        bootstrap.invalidateAndRebootstrap().catch(err => {
            console.warn('[Setup] re-bootstrap failed (non-fatal):', err.message);
        });
    }

    const probeRes = await probe(saved.apiBaseUrl).catch(() => null);
    res.json({ saved, probe: probeRes, restartRequired: false });
});

module.exports = router;
