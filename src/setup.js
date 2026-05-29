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

const crypto = require('crypto');
const config = require('./config');
const setupConfig = require('./setupConfig');
const bootstrap = require('./bootstrap'); // for re-bootstrap on URL change
const auth = require('./auth');

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
    if (!hasTenantKey && pending && pending.status === 'awaiting_email_verification') state = 'awaiting_email_verification';
    else if (!hasTenantKey && pending && pending.status === 'pending') state = 'awaiting_admin_approval';
    else if (!hasTenantKey && lastError && lastError.status === 'failed') state = 'failed';
    else if (!hasTenantKey) state = 'initialising';

    res.json({
        state,
        hasTenantKey,
        apiBaseUrl: config.apiBaseUrl,
        organizationId: config.organizationId || null,
        ncInstanceId: config.ncInstanceId || null,
        // Non-sensitive details for the in-app verification screen. The pendingId
        // is deliberately NOT exposed — the browser only ever sends the code to
        // the connector-owned /setup/verify-email-code route, which uses the
        // connector's own stored pending state.
        verification: (pending && pending.status === 'awaiting_email_verification') ? {
            maskedEmail: pending.maskedEmail || null,
            expiresAt: pending.expiresAt || null,
            organizationName: pending.organizationName || null,
            emailSent: pending.emailSent !== false,
        } : null,
        pending: (pending && pending.status === 'pending') ? {
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

// Rotate the per-install tenant key — drop the cached key + run a fresh
// bootstrap against the same SaaS so the org binding survives but every
// downstream signature changes. Surfaced via the "Rotate tenant key"
// button in NC admin settings (declarativeSettings.js). Synchronous: the
// caller blocks until SaaS responds so the UI can show success or the
// concrete remediation in one click. invalidateAndRebootstrap() rolls back
// to the previous key on failure so a momentary SaaS outage can't strand
// the install.
router.post('/rotate-tenant-key', express.json(), async (req, res) => {
    const uid = req.beeflow?.user?.uid || 'unknown';
    console.log(`[Setup] tenant-key rotation requested by uid=${uid}`);
    try {
        await bootstrap.invalidateAndRebootstrap();
        console.log(`[Setup] tenant-key rotated by uid=${uid} — org ${config.organizationId}`);
        res.json({
            ok: true,
            organizationId: config.organizationId,
            tenantKeyFingerprint: crypto.createHash('sha256')
                .update(String(config.tenantKey))
                .digest('hex')
                .slice(0, 16),
        });
    } catch (err) {
        console.warn(`[Setup] tenant-key rotation FAILED for uid=${uid}: ${err.message}`);
        res.status(502).json({
            ok: false,
            error: err.message,
            remediation: err.remediation || 'Check connector logs for the SaaS response, then retry.',
        });
    }
});

// Bind this Nextcloud install to an existing Bee Flow organisation by
// redeeming a one-shot pairing code minted in the SaaS admin UI. Without
// this UI path, admins had to SSH into the NC host and set
// BEEFLOW_PAIRING_CODE via `occ app_api:app:setenv` + container restart —
// a flow no real Nextcloud admin would tolerate.
const PAIRING_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
router.post('/apply-pairing-code', express.json(), async (req, res) => {
    const uid = req.beeflow?.user?.uid || 'unknown';
    const raw = String(req.body?.pairingCode || '').toUpperCase().trim();
    if (!PAIRING_CODE_RE.test(raw)) {
        return res.status(400).json({
            ok: false,
            error: 'Invalid pairing code format',
            remediation: 'Pairing codes look like XXXX-XXXX (8 letters/digits, one dash).',
        });
    }
    console.log(`[Setup] pairing code applied by uid=${uid} (${raw.slice(0, 4)}***)`);
    try {
        await bootstrap.invalidateAndRebootstrap({ pairingCode: raw });
        console.log(`[Setup] pairing code redeemed by uid=${uid} — org ${config.organizationId}`);
        res.json({
            ok: true,
            organizationId: config.organizationId,
            tenantKeyFingerprint: crypto.createHash('sha256')
                .update(String(config.tenantKey))
                .digest('hex')
                .slice(0, 16),
        });
    } catch (err) {
        console.warn(`[Setup] pairing code redemption FAILED for uid=${uid}: ${err.message}`);
        res.status(502).json({
            ok: false,
            error: err.message,
            remediation: err.remediation || 'The pairing code may be expired or already redeemed. Generate a new one in your Bee Flow admin panel and try again.',
        });
    }
});

// Confirm the emailed verification code, entered by the admin in the embedded
// Bee Flow view. Connector-owned (works before a tenant key exists) and reached
// only through NC's AppAPI proxy, so the caller is an authenticated NC user; the
// emailed 6-digit code (attempt-capped + rate-limited on the SaaS) is the proof
// of authority. On success the connector caches the tenant key and the SPA can
// reload into the full app.
router.post('/verify-email-code', express.json(), async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ ok: false, code: 'invalid_code', error: 'Enter the 6-digit code from the email.' });
    }
    const uid = req.beeflow?.user?.uid || 'unknown';
    try {
        const result = await bootstrap.submitVerificationCode(code);
        console.log(`[Setup] email verification confirmed by uid=${uid} — org ${result.organizationId}`);
        return res.json({ ok: true, organizationId: result.organizationId, organizationName: result.organizationName });
    } catch (err) {
        const status = err.code === 'no_pending' ? 409
            : err.status === 410 ? 410
            : err.status === 429 ? 429
            : err.status === 404 ? 404
            : (err.status && err.status >= 500) || err.code === 'saas_unreachable' ? 502
            : 400;
        return res.status(status).json({
            ok: false,
            code: err.code || 'verify_failed',
            error: err.message,
            ...(typeof err.attemptsLeft === 'number' ? { attemptsLeft: err.attemptsLeft } : {}),
        });
    }
});

// Send (or re-send) the verification code to the admin actually doing the setup
// — the current NC user in the embedded view. Re-points the pending binding at
// them so the code reaches the right person and they become the org admin on
// success. NC-authenticated via AppAPI; gated to NC admins with an email.
router.post('/request-verification-code', express.json(), async (req, res) => {
    const current = req.beeflow?.user;
    if (!current?.uid) {
        return res.status(401).json({ ok: false, code: 'no_user', error: 'Could not identify your Nextcloud account. Refresh and try again.' });
    }
    if (!current.email) {
        return res.status(400).json({ ok: false, code: 'no_email', error: 'Your Nextcloud account has no email address. Add one in Nextcloud (Settings → Users) to finish setup.' });
    }
    const admin = await bootstrap.isNcAdmin(current.uid);
    if (!admin) {
        return res.status(403).json({ ok: false, code: 'not_admin', error: 'Only a Nextcloud admin can finish connecting Bee Flow.' });
    }
    try {
        const result = await bootstrap.requestVerificationCode({ uid: current.uid, email: current.email, displayName: current.displayName });
        return res.json({ ok: true, maskedEmail: result.maskedEmail, expiresAt: result.expiresAt, emailSent: result.emailSent });
    } catch (err) {
        const status = err.code === 'no_pending' ? 409
            : err.code === 'email_not_in_org' || err.status === 403 ? 403
            : err.status === 410 ? 410
            : err.status === 429 ? 429
            : err.code === 'saas_unreachable' || (err.status && err.status >= 500) ? 502
            : 400;
        return res.status(status).json({ ok: false, code: err.code || 'request_failed', error: err.message });
    }
});

// Re-send the verification code to the same admin mailbox.
router.post('/resend-email-code', express.json(), async (req, res) => {
    try {
        const result = await bootstrap.resendVerificationCode();
        return res.json({ ok: true, maskedEmail: result.maskedEmail, expiresAt: result.expiresAt, emailSent: result.emailSent });
    } catch (err) {
        const status = err.code === 'no_pending' ? 409
            : err.status === 410 ? 410
            : err.status === 429 ? 429
            : 502;
        return res.status(status).json({ ok: false, code: err.code || 'resend_failed', error: err.message });
    }
});

// One-shot diagnostic: ask the SaaS what it has stored for *this* NC
// instance and cross-check with our local cached tenant key. Use this when
// /api/* returns "no matching tenant key" so we can pinpoint whether the
// SaaS has no key, has an unrelated key, or has the right key but the
// signature verification is failing for some other reason (clock skew,
// encryption key rotation on the server pod, …).
router.post('/diagnose', express.json(), async (_req, res) => {
    const out = {
        local: {
            apiBaseUrl: config.apiBaseUrl,
            organizationId: config.organizationId || null,
            ncInstanceId: config.ncInstanceId || null,
            hasTenantKey: !!config.tenantKey,
            tenantKeyFingerprint: config.tenantKey
                ? crypto.createHash('sha256').update(config.tenantKey).digest('hex').slice(0, 16)
                : null,
        },
        saas: null,
        match: null,
        error: null,
    };

    let caps;
    try {
        caps = await bootstrap.fetchCapabilities();
    } catch (e) {
        out.error = `Could not read NC capabilities: ${e.message}`;
        return res.status(200).json(out);
    }
    out.local.liveNcInstanceId = caps.instanceId;

    // Sign a throw-away JWT with the local tenant key so the SaaS can tell
    // us whether verification actually succeeds against the key it has on
    // file. This is the smoking-gun check.
    let testToken = null;
    if (config.tenantKey) {
        try {
            testToken = auth.mintSaasJwt({
                uid: 'diag-probe',
                email: 'diag-probe@example.invalid',
                displayName: 'diag-probe',
            });
        } catch (_) { /* tolerate — diag still useful without a token */ }
    }

    const ncBase = config.nextcloudPublicUrl || config.nextcloudUrl;
    const target = `${config.apiBaseUrl}/auth/connector/diagnose`;
    let saasRes;
    try {
        saasRes = await fetch(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Beeflow-Source': 'nextcloud-connector',
                'X-Beeflow-NC-Instance-Id': caps.instanceId,
                'X-Beeflow-NC-Base-Url': ncBase,
            },
            body: JSON.stringify(testToken ? { testToken } : {}),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        out.error = `SaaS diagnose unreachable: ${e.message}`;
        return res.status(200).json(out);
    }
    const text = await saasRes.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 500) }; }
    out.saas = { status: saasRes.status, ...body };

    // Compare fingerprints when both sides have one.
    if (out.local.tenantKeyFingerprint && out.saas?.tenantKey?.fingerprint) {
        out.match = out.local.tenantKeyFingerprint === out.saas.tenantKey.fingerprint
            ? 'fingerprints_match'
            : 'fingerprint_mismatch — local and SaaS hold different keys for this org';
    } else if (!out.local.tenantKeyFingerprint) {
        out.match = 'local has no cached tenant key — bootstrap has not completed';
    } else if (!out.saas?.tenantKey?.exists) {
        out.match = 'SaaS has no tenant key for this org — bootstrap never reached persist step';
    }

    return res.json(out);
});

module.exports = router;
