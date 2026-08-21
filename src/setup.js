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
 *
 * Every route here is additionally rate-limited and, where it changes state for
 * the whole organisation, re-checks Nextcloud admin membership rather than
 * trusting info.xml's access_level alone — Nextcloud's guidance is that an app
 * verifies authorisation itself even where the framework appears to have done
 * it (developer_manual/prologue/security.html).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');
const config = require('./config');
const setupConfig = require('./setupConfig');
const bootstrap = require('./bootstrap'); // for re-bootstrap on URL change
const auth = require('./auth');
const rateLimit = require('./rateLimit');
const { assertAllowedUrl, parseAllowedUrl } = require('./remoteHost');
const { ncTlsMode } = require('./ncTls'); // NC TLS posture for diagnostics
const ncProxy = require('./ncProxy'); // callback-signature health for diagnostics

const router = express.Router();

const HTML_PATH = path.join(__dirname, 'setup.html');
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Guard for the routes that reconfigure or re-bind the whole organisation.
 *
 * info.xml already declares these ADMIN, and AppAPI enforces that — but this is
 * the check that survives an info.xml edit, a route pattern that stops matching
 * after a rename, or an AppAPI version whose enforcement differs. The uid and
 * its group membership both come from Nextcloud (auth.js → OCS), not from the
 * request body.
 */
function requireNcAdmin(req, res, next) {
    const user = req.beeflow?.user;
    if (!user?.uid) {
        return res.status(401).json({
            ok: false, code: 'no_user',
            error: 'Could not identify your Nextcloud account. Refresh and try again.',
        });
    }
    if (!user.isNcAdmin) {
        console.warn(`[Setup] denied ${req.method} ${req.originalUrl} for non-admin uid=${user.uid}`);
        return res.status(403).json({
            ok: false, code: 'not_admin',
            error: 'Only a Nextcloud administrator can change the Bee Flow connection.',
        });
    }
    return next();
}

// Budgets. Generous enough that a real admin clicking around never sees one,
// tight enough that the emailed 6-digit code cannot be walked and that the
// re-bootstrap actions cannot be used to hammer the Bee Flow server.
const limits = {
    // The one endpoint with a guessable secret behind it. The Bee Flow server
    // caps attempts too; this stops the connector being used to parallelise
    // them from a single Nextcloud account.
    verify: rateLimit.limit('setup-verify-code', {
        limit: 10, windowMs: 10 * 60_000,
        message: 'Too many verification attempts. Wait a few minutes and try again.',
    }),
    // Sending mail on demand — the abuse case is mailbox flooding.
    sendCode: rateLimit.limit('setup-send-code', {
        limit: 5, windowMs: 15 * 60_000,
        message: 'Too many code requests. Wait a few minutes before asking for another.',
    }),
    // Outbound probes of an admin-supplied URL.
    probe: rateLimit.limit('setup-probe', { limit: 20, windowMs: 60_000 }),
    // Anything that re-bootstraps against the Bee Flow server.
    rebind: rateLimit.limit('setup-rebind', { limit: 10, windowMs: 10 * 60_000 }),
};

/** Probe a Bee Flow service /api/health endpoint. */
async function probe(url) {
    // Validate before connecting — an admin-supplied hostname must not be able
    // to reach link-local/cloud-metadata infrastructure through the connector.
    try {
        await assertAllowedUrl(url, { label: 'Bee Flow server URL' });
    } catch (err) {
        return { ok: false, status: 0, url: String(url), error: err.message };
    }
    const target = `${url.replace(/\/+$/, '')}/api/health`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
        // Redirects are NOT followed. A validated hostname that 302s to
        // 169.254.169.254 is the standard way round a host allow-list, and the
        // admin is better served by being told to enter the final URL anyway.
        const res = await fetch(target, { signal: ac.signal, redirect: 'manual' });
        clearTimeout(t);
        if (res.status >= 300 && res.status < 400) {
            return {
                ok: false,
                status: res.status,
                url: target,
                error: `the server redirected (HTTP ${res.status}) — enter the final URL directly`,
            };
        }
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

/**
 * Does `candidateUrl` answer as THIS Nextcloud?
 *
 * The ExApp analogue of `OCP\Security\ITrustedDomainHelper::isTrustedUrl()`:
 * a PHP app asks the server whether a URL is one of its own trusted domains,
 * and an ExApp has to ask the instance directly. Nextcloud publishes a stable
 * per-instance id in its unauthenticated capabilities payload, so comparing
 * that against the one we already talk to answers the question exactly.
 *
 * @returns {Promise<{result: 'match'|'mismatch'|'unknown'|'unreachable', detail?: string}>}
 *          'unknown' when either side publishes no instance id — the check
 *          abstains rather than guessing, because the caller treats a mismatch
 *          as a hard rejection.
 */
async function instanceIdOf(baseUrl) {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/ocs/v2.php/cloud/capabilities?format=json`, {
        headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'follow', // a public NC URL behind a http→https redirect is normal
    });
    // Redirects are followed here (unlike the /api/health probe) because a
    // public Nextcloud URL legitimately sits behind one — so re-check where we
    // actually landed, or the allow-list only covers the first hop.
    try {
        parseAllowedUrl(res.url, { label: 'capabilities URL' });
    } catch (err) {
        throw new Error(`redirected somewhere this connector will not follow: ${err.message}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json())?.ocs?.data;
    // Only the id Nextcloud itself publishes. bootstrap.js can synthesise a
    // host-derived fallback, which by construction differs between the internal
    // and public URL and would make every check a false mismatch.
    return data?.capabilities?.theming?.instanceid || data?.capabilities?.core?.instanceid || null;
}

async function pointsAtThisNextcloud(candidateUrl) {
    let mine;
    try {
        mine = await instanceIdOf(config.nextcloudUrl);
    } catch (err) {
        return { result: 'unknown', detail: `could not read this Nextcloud's instance id: ${err.message}` };
    }
    if (!mine) return { result: 'unknown', detail: 'this Nextcloud publishes no instance id' };

    let theirs;
    try {
        theirs = await instanceIdOf(candidateUrl);
    } catch (err) {
        return { result: 'unreachable', detail: err.message };
    }
    if (!theirs) return { result: 'unknown', detail: 'the candidate URL publishes no instance id' };
    return theirs === mine ? { result: 'match' } : { result: 'mismatch' };
}

router.get('/', (req, res) => {
    if (!fs.existsSync(HTML_PATH)) {
        return res.status(500).type('text/plain').send('setup.html missing — connector packaging error');
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(HTML_PATH);
});

router.get('/status', requireNcAdmin, (req, res) => {
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
router.get('/diagnostics', requireNcAdmin, (req, res) => {
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

    // Nextcloud TLS posture. When the connector had to relax verification for
    // the NC origin (self-signed / internal-CA cert), warn that on an AIO/HaRP
    // deployment the embedded app will not load until HaRP and Nextcloud's own
    // PHP also trust the certificate — the connector can only fix its own hop.
    const ncTls = {
        mode: ncTlsMode, // 'default' | 'insecure' | 'ca'
        warning: ncTlsMode === 'insecure'
            ? 'Nextcloud uses a self-signed or internal-CA certificate. The connector trusts it automatically, but on a Nextcloud AIO + HaRP deployment the embedded app will stay blank until HaRP and Nextcloud itself also trust this certificate. For local testing run the connector repo helper scripts/aio-trust-local-cert.sh; in production use a valid (publicly-trusted) certificate.'
            : null,
    };

    res.json({
        state,
        hasTenantKey,
        apiBaseUrl: config.apiBaseUrl,
        organizationId: config.organizationId || null,
        ncInstanceId: config.ncInstanceId || null,
        ncTls,
        // Callback-signature health. Repeated rejections mean the Bee Flow
        // server and this host disagree about the tenant key or the clock —
        // and under HaRP a run of them gets the SaaS's egress IP banned
        // (~10 4xx within 300s), which takes out file access and user sync
        // tenant-wide. Surfaced so an admin sees the cause, not just the
        // symptom.
        callbackSignatures: (() => {
            const s = ncProxy.sigFailureStats();
            return {
                ...s,
                warning: s.consecutive >= 5
                    ? 'The Bee Flow server\'s calls back into Nextcloud are being rejected. Check that this host\'s clock is in sync (NTP) and that the tenant key has not been rotated on only one side — under HaRP a sustained run of these also gets the Bee Flow server\'s IP temporarily banned.'
                    : null,
            };
        })(),
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

router.post('/test', requireNcAdmin, limits.probe, express.json(), async (req, res) => {
    const url = String(req.body?.apiBaseUrl || '').trim();
    if (!url) return res.status(400).json({ error: 'apiBaseUrl required' });
    const result = await probe(url);
    res.json(result);
});

// Admin-supplied public NC URL — used by the SaaS to call back into NC
// for ownership verification + runtime callbacks. Only needed when NC
// is behind NAT and BEEFLOW_NC_PUBLIC_URL wasn't set at deploy time.
// Empty body clears the override and falls back to NEXTCLOUD_URL.
router.post('/public-nc-url', requireNcAdmin, limits.rebind, express.json(), async (req, res) => {
    const url = String(req.body?.publicNcUrl || '').trim();
    if (url) {
        try {
            await assertAllowedUrl(url, { label: 'Public Nextcloud URL' });
        } catch (err) {
            return res.status(400).json({ error: err.message, code: err.code });
        }
        // Trusted-domain check — the ExApp analogue of ITrustedDomainHelper.
        // This URL is handed to the Bee Flow server as the address to call back
        // on, so a typo here does not fail closed: it points another party's
        // Bee Flow callbacks, carrying this organisation's identity, at a host
        // the admin does not control. Confirm it really is this Nextcloud.
        const verdict = await pointsAtThisNextcloud(url);
        if (verdict.result === 'mismatch') {
            return res.status(400).json({
                code: 'not_this_nextcloud',
                error: 'That URL answers as a different Nextcloud instance. '
                    + 'Enter the public address of THIS Nextcloud.',
            });
        }
        if (verdict.result === 'unreachable') {
            // Expected for a NAT/tunnel setup that is not up yet — this field
            // exists for exactly that case, so warn rather than refuse.
            console.warn(`[Setup] public NC URL ${url} is not reachable from the connector `
                + `(${verdict.detail}) — saving it unverified.`);
        }
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

router.post('/', requireNcAdmin, limits.rebind, express.json(), async (req, res) => {
    // Note: BEEFLOW_API_BASE_URL used to hard-lock this endpoint to whatever
    // value AppAPI env passed in. That made the in-NC settings panel
    // (declarativeSettings.js) read-only in the local sandbox, which always
    // sets the env var. The env now seeds the initial value via config.js
    // but admin overrides through this endpoint or the NC settings panel
    // win at runtime — last-writer wins, persisted via setupConfig.
    let { mode, apiBaseUrl } = req.body || {};
    if (mode === 'cloud') apiBaseUrl = setupConfig.CLOUD_URL;

    // DNS-level check before we persist and start signing requests to it.
    // setupConfig.save() re-runs the synchronous half of this; here we can also
    // resolve the name, which is what catches a hostname pointing at metadata.
    if (mode !== 'cloud') {
        try {
            await assertAllowedUrl(apiBaseUrl, { label: 'Bee Flow server URL' });
        } catch (err) {
            return res.status(400).json({ error: err.message, code: err.code });
        }
    }

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
router.post('/rotate-tenant-key', requireNcAdmin, limits.rebind, express.json(), async (req, res) => {
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

// Clear the connector's cached organisation binding and re-bootstrap from
// scratch. Unlike "rotate" (which keeps the same org and just mints a new key),
// this is the recovery action when the cached org is stale — e.g. the Bee Flow
// organisation was deleted/recreated on the server side and the connector is
// still holding a tenant key for an org that no longer exists (every SaaS call
// then 401s). invalidateAndRebootstrap() deletes tenant-key.json +
// pending-bootstrap.json, clears the in-memory binding, and re-bootstraps: if
// the org still exists it re-binds to it, otherwise it provisions a fresh one.
// Rollback to the previous key happens automatically if the re-bootstrap fails.
router.post('/clear-cache', requireNcAdmin, limits.rebind, express.json(), async (req, res) => {
    const uid = req.beeflow?.user?.uid || 'unknown';
    console.log(`[Setup] organisation cache clear requested by uid=${uid}`);
    try {
        await bootstrap.invalidateAndRebootstrap();
        console.log(`[Setup] organisation cache cleared by uid=${uid} — org ${config.organizationId}`);
        res.json({
            ok: true,
            organizationId: config.organizationId,
            organizationName: config.organizationName || null,
            tenantKeyFingerprint: config.tenantKey
                ? crypto.createHash('sha256').update(String(config.tenantKey)).digest('hex').slice(0, 16)
                : null,
        });
    } catch (err) {
        console.warn(`[Setup] organisation cache clear FAILED for uid=${uid}: ${err.message}`);
        res.status(502).json({
            ok: false,
            error: err.message,
            remediation: err.remediation || 'Check the connector logs for the Bee Flow server response, then retry.',
        });
    }
});

// Bind this Nextcloud install to an existing Bee Flow organisation by
// redeeming a one-shot pairing code minted in the SaaS admin UI. Without
// this UI path, admins had to SSH into the NC host and set
// BEEFLOW_PAIRING_CODE via `occ app_api:app:setenv` + container restart —
// a flow no real Nextcloud admin would tolerate.
const PAIRING_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
router.post('/apply-pairing-code', requireNcAdmin, limits.verify, express.json(), async (req, res) => {
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
// only through NC's AppAPI proxy, so the caller is an authenticated NC user.
//
// Three things gate it, not one: the caller must be a Nextcloud admin (the code
// is only ever sent to an admin mailbox, so nothing legitimate is lost, and it
// stops any user on the instance from walking the code space), the connector
// rate-limits attempts, and the Bee Flow server attempt-caps the code itself.
// Nextcloud's manual asks for exactly this shape — a limiter in front of an
// operation with a guessable secret, answering 429 when the budget is spent.
router.post('/verify-email-code', requireNcAdmin, limits.verify, express.json(), async (req, res) => {
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
router.post('/request-verification-code', limits.sendCode, express.json(), async (req, res) => {
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

// Re-send the verification code to the same admin mailbox. Admin-gated and
// rate-limited: without both, any user on the instance could make the Bee Flow
// server mail the admin on demand.
router.post('/resend-email-code', requireNcAdmin, limits.sendCode, express.json(), async (req, res) => {
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
router.post('/diagnose', requireNcAdmin, limits.probe, express.json(), async (_req, res) => {
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
