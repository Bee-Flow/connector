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
    });
});

router.post('/test', express.json(), async (req, res) => {
    const url = String(req.body?.apiBaseUrl || '').trim();
    if (!url) return res.status(400).json({ error: 'apiBaseUrl required' });
    const result = await probe(url);
    res.json(result);
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
