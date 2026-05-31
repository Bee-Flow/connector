/**
 * One-click bootstrap: turn a fresh ExApp install into a fully-configured
 * Bee Flow tenant without the NC admin having to paste anything.
 *
 * Triggered from server.js on startup (and again on /init lifecycle if cache
 * is missing). Behaviour:
 *
 *   1. If BEEFLOW_TENANT_KEY was explicitly set in env (not "auto") → done,
 *      use that. This preserves the legacy flow for self-hosted customers
 *      who pre-mint keys via the admin UI.
 *
 *   2. Otherwise look for a cached key in APP_PERSISTENT_STORAGE. AppAPI
 *      mounts this volume per ExApp; it survives container recreate but is
 *      lost on full uninstall. Reusing the cached key keeps the same Bee
 *      Flow org bound across upgrades.
 *
 *   3. If no cache, gather instance metadata from NC's OCS capabilities API
 *      and POST to <apiBaseUrl>/auth/connector/bootstrap. The SaaS verifies
 *      the call by independently re-fetching capabilities (anti-spoofing).
 *      On success: store the returned tenant key in the cache file (mode
 *      0600) and continue.
 *
 * On any failure during bootstrap we surface a clear error and let the
 * connector fall through; the heartbeat will report the problem to AppAPI
 * and the admin sees an "ExApp unhealthy" state rather than a silent
 * misconfiguration.
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const CACHE_FILE = 'tenant-key.json';
const PENDING_FILE = 'pending-bootstrap.json';
const ERROR_FILE = 'bootstrap-last-error.json';
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 5_000;
const POLL_GRACE_AFTER_EXPIRY_MS = 5 * 60_000;

// Hostname of a Nextcloud base URL. MUST stay byte-identical to the SaaS copy
// in server/auth/orgNaming.js (ncHostFromUrl) — the connector can't require
// server code, so the logic is duplicated.
function ncHostFromUrl(ncBaseUrl) {
    try {
        return new URL(ncBaseUrl).host || null;
    } catch {
        return null;
    }
}

// Stable fallback id for Nextclouds that expose neither theming.instanceid nor
// core.instanceid. Keyed on the NC host so it stays constant across NC upgrades
// instead of drifting with the version string (which would silently re-provision
// a duplicate org on the next cache-loss re-bootstrap). MUST match the SaaS copy
// in server/auth/connectorBootstrap.js (stableInstanceIdFallback) byte-for-byte.
function stableInstanceIdFallback(ncBaseUrl, themingName) {
    const host = ncHostFromUrl(ncBaseUrl);
    if (host) return `nc-host:${host}`;
    return `nc:${themingName || 'nextcloud'}`;
}

async function readCache() {
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        const raw = await fs.readFile(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.tenantKey) return parsed;
    } catch { /* missing or unreadable */ }
    return null;
}

async function writeCache(data) {
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        await fs.mkdir(config.persistentStorage, { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (e) {
        console.warn(`[Bootstrap] Could not persist tenant key to ${cachePath}: ${e.message}`);
    }
}

async function readPendingFile() {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.pendingId && (parsed?.pollUrl || parsed?.verifyUrl)) return parsed;
    } catch { /* missing */ }
    return null;
}

async function writePendingFile(data) {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try {
        await fs.mkdir(config.persistentStorage, { recursive: true });
        await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (e) {
        console.warn(`[Bootstrap] Could not persist pending state to ${p}: ${e.message}`);
    }
}

async function deletePendingFile() {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try { await fs.unlink(p); } catch (_) { /* gone */ }
}

async function fetchCapabilities() {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/capabilities?format=json`;
    const res = await fetch(url, {
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`NC capabilities HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.ocs?.data;
    if (!data?.version) throw new Error('NC capabilities missing version data');
    const themingName = data?.capabilities?.theming?.name || 'Nextcloud';
    let instanceId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid;
    if (!instanceId) {
        // No stable id from NC. Derive one from the public base URL host (the
        // same value we send as X-Beeflow-NC-Base-Url and that the SaaS
        // re-derives) so it doesn't change when NC is upgraded — which would
        // otherwise create a duplicate org on the next re-bootstrap.
        instanceId = stableInstanceIdFallback(config.nextcloudPublicUrl || config.nextcloudUrl, themingName);
        console.warn(`[Bootstrap] NC exposes no theming/core instanceid; using stable host fallback '${instanceId}'`);
    }
    return { instanceId, themingName, version: data?.version?.string || 'unknown' };
}

// Discover the NC instance admin without needing admin-context auth.
//
// Strategy:
//   1. Call AppAPI's own `/ocs/v2.php/apps/app_api/api/v1/users` — it
//      accepts service-level AppAPI auth (empty userId) and returns every
//      NC uid the ExApp is allowed to see.
//   2. For each uid, fetch its user info via `/ocs/v2.php/cloud/users/{uid}`
//      with that uid as the AppAPI auth principal. NC honours self-lookup
//      and the response includes `groups`.
//   3. First uid whose groups include `admin` is the bootstrap admin.
//   4. If no admin group is reported (unusual / brand-new install), fall
//      back to the first uid as a best-effort.
async function appApiOcsHeaders(asUid = '') {
    return {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'AUTHORIZATION-APP-API': Buffer.from(`${asUid}:${config.appSecret}`).toString('base64'),
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
    };
}

async function fetchAllUids() {
    const url = `${config.nextcloudUrl}/ocs/v2.php/apps/app_api/api/v1/users?format=json`;
    // Tolerate the AppAPI auth warm-up window on a fresh install (~6s of 997)
    // so the admin lookup that drives org provisioning converges in one pass.
    const headers = await appApiOcsHeaders('');
    const res = await withWarmupRetry(() => fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
    }), { label: 'users-list', budgetMs: 60_000 });
    if (!res.ok) throw new Error(`AppAPI users list HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.ocs?.data;
    if (!Array.isArray(data)) throw new Error('Unexpected users-list payload');
    return data;
}

async function fetchUserInfo(uid) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const headers = await appApiOcsHeaders(uid);
    const res = await withWarmupRetry(() => fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
    }), { label: 'user-info', budgetMs: 30_000 });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ocs?.data || null;
}

async function fetchAdminUidsViaGroup() {
    // OCS gives us the admin-group members directly — single round-trip
    // instead of N user-info lookups. Returns null on any failure so the
    // caller can fall back to the slow path.
    try {
        const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/groups/admin/users?format=json`;
        const res = await fetch(url, {
            headers: await appApiOcsHeaders(''),
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const body = await res.json();
        const data = body?.ocs?.data?.users;
        return Array.isArray(data) && data.length > 0 ? data : null;
    } catch { return null; }
}

// Thrown when an admin user exists but none has an email address. A real
// email is load-bearing: it's how the SaaS links this NC to the installer's
// Bee Flow account (email-match adoption) and how the same person bypasses the
// onboarding gate when they open the SPA. Synthesising `<uid>@example.local`
// silently creates an orphan org that nobody can actually use, so we fail
// loudly with actionable remediation instead.
function adminNoEmailError() {
    const e = new Error('The Nextcloud admin user has no email address configured');
    e.code = 'admin_email_missing';
    return e;
}

function pickAdmin(uid, info) {
    return {
        uid,
        email: info.email,
        displayName: info.displayname || info['display-name'] || uid,
    };
}

async function fetchFirstAdmin() {
    // Fast path: ask NC for the admin-group membership directly. One round-
    // trip instead of `fetchAllUids` + N × `fetchUserInfo` (which on a 100-
    // user instance was up to 1000s). Return the first admin that has a real
    // email — never synthesise one.
    const adminUids = await fetchAdminUidsViaGroup();
    if (adminUids) {
        for (const uid of adminUids) {
            const info = await fetchUserInfo(uid);
            if (info?.email) return pickAdmin(uid, info);
        }
        // Admin group resolved but no member has an email — can't reliably
        // link to a Bee Flow account.
        throw adminNoEmailError();
    }

    // Slow-path fallback: AppAPI version doesn't expose /cloud/groups/admin/users.
    // Walk the user list in parallel batches of 5 instead of one-by-one.
    const uids = await fetchAllUids();
    if (uids.length === 0) throw new Error('No NC users visible to the ExApp');
    let sawAdminWithoutEmail = false;
    const BATCH_SIZE = 5;
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);
        const infos = await Promise.all(batch.map(uid =>
            fetchUserInfo(uid).then(info => ({ uid, info })).catch(() => ({ uid, info: null }))
        ));
        for (const { uid, info } of infos) {
            if (!info) continue;
            const groups = info.groups || [];
            if (groups.includes('admin')) {
                if (info.email) return pickAdmin(uid, info);
                sawAdminWithoutEmail = true;
            }
        }
    }
    if (sawAdminWithoutEmail) throw adminNoEmailError();
    throw new Error('Could not determine an NC admin with an email address');
}

// Pending-state runtime visibility — heartbeat.js reads this to surface
// "awaiting admin approval" through AppAPI's ExApp status.
let pendingState = null;
function getPendingState() { return pendingState; }

// Last-error visibility — heartbeat.js + /setup/diagnostics surface this so
// the NC admin sees a categorised, actionable failure (with remediation
// text) instead of a silent stuck bootstrap. Cleared on success.
//
// REMEDIATION lives here (single source of truth) so heartbeat.js and
// setup.js can both consume it without drifting.
const REMEDIATION = {
    saas_unreachable:
        'The Bee Flow service is not reachable from this Nextcloud. Test with `curl https://server.beeflow.nl/api/health` from the connector container and whitelist that hostname in your egress firewall.',
    nc_not_publicly_reachable:
        'Bee Flow Cloud cannot reach this Nextcloud for user-sync callbacks. Set BEEFLOW_NC_PUBLIC_URL to your public NC URL, or switch to self-hosted mode via the setup picker.',
    admin_lookup_failed:
        'No admin user found in this Nextcloud. Add one with `occ user:add --group admin <uid>` then redeploy the connector.',
    admin_email_missing:
        'Your Nextcloud admin user has no email address. Set an email on the admin account (Settings → Users) and redeploy the connector, or bind this Nextcloud to an existing Bee Flow organisation with a pairing code.',
    saas_auth_rejected:
        'The Bee Flow service rejected our credentials. Check that this NC instance has not been disabled in your Bee Flow organisation.',
    tenant_already_provisioned:
        'This Nextcloud was bootstrapped previously and the tenant-key cache was lost. Recover the key from the Bee Flow admin UI, then set BEEFLOW_TENANT_KEY via `occ app_api:app:setenv`.',
    pairing_required:
        'This Bee Flow server does not auto-create organisations. Ask your Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud), set it as BEEFLOW_PAIRING_CODE via `occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <CODE>`, then redeploy the connector.',
    appstore_signature_invalid:
        'The downloaded connector tarball failed signature verification. Uninstall and reinstall from the App Store.',
    unknown:
        'Bootstrap failed. Check `docker logs nc_app_bee_flow --tail 200` for details.',
};
function remediationFor(category) {
    return REMEDIATION[category] || REMEDIATION.unknown;
}

let lastErrorState = null;
function getLastErrorState() { return lastErrorState; }
async function readErrorFile() {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.category) return parsed;
    } catch { /* missing */ }
    return null;
}
async function writeErrorFile(data) {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    try {
        await fs.mkdir(config.persistentStorage, { recursive: true });
        await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (e) {
        console.warn(`[Bootstrap] Could not persist error state to ${p}: ${e.message}`);
    }
}
async function clearErrorFile() {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    try { await fs.unlink(p); } catch (_) { /* already gone */ }
    lastErrorState = null;
}

// SaaS-side structured `code` values that map directly to a connector
// category — preferred over string-matching on the error message because
// it's stable across SaaS releases.
const SAAS_CODE_TO_CATEGORY = {
    nc_capabilities_unreachable: 'nc_not_publicly_reachable',
    nc_capabilities_mismatch: 'nc_capabilities_mismatch',
    missing_headers: 'connector_outdated',
    invalid_admin_email: 'admin_email_invalid',
    admin_email_conflict: 'admin_email_conflict',
    too_many_pending_bindings: 'too_many_pending',
    pending_admin_approval: 'awaiting_admin_approval',
    org_create_failed: 'saas_transient',
    pairing_required: 'pairing_required',
};

// Categorise a thrown error into one of the well-known buckets that the
// SPA's error overlay knows how to render. Prefers a structured `code`
// set on the error (from a parsed SaaS response) and falls back to
// message inspection. Anything we don't recognise falls through as
// `unknown` — still surfaced, just without specific remediation copy.
function categoriseError(err, phase) {
    if (err?.code && SAAS_CODE_TO_CATEGORY[err.code]) return SAAS_CODE_TO_CATEGORY[err.code];
    // Connector-local codes (set before the SaaS POST) take precedence over the
    // phase-based buckets below — otherwise phase==='admin' would mislabel a
    // missing-email failure as a generic admin_lookup_failed.
    if (err?.code === 'admin_email_missing') return 'admin_email_missing';
    const msg = String(err?.message || err || '');
    if (phase === 'capabilities' || /NC capabilities/i.test(msg)) return 'nc_not_publicly_reachable';
    if (phase === 'admin' || /admin/i.test(msg) && /No NC users|admin from user list/i.test(msg)) return 'admin_lookup_failed';
    if (/HTTP 401|HTTP 403/i.test(msg)) return 'saas_auth_rejected';
    if (/HTTP 409/i.test(msg)) return 'tenant_already_provisioned';
    if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|fetch failed|network|AbortError|timeout/i.test(msg)) return 'saas_unreachable';
    if (/signature/i.test(msg)) return 'appstore_signature_invalid';
    return 'unknown';
}

// Record a bootstrap failure for surfacing to /heartbeat and /setup/diagnostics.
// Always best-effort: any failure to persist the error itself is logged but
// not re-thrown (we don't want failure-reporting to mask the real failure).
// `opts.remediation` overrides the static REMEDIATION copy when the SaaS
// returned a more specific message (e.g. tunnel guidance for the current
// NC URL).
async function recordBootstrapError(err, phase, opts = {}) {
    const category = categoriseError(err, phase);
    const now = new Date().toISOString();
    const state = {
        status: 'failed',
        category,
        phase: phase || 'unknown',
        error: String(err?.message || err || 'unknown'),
        remediation: opts.remediation || err?.remediation || null,
        lastAttemptAt: now,
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    lastErrorState = state;
    await writeErrorFile(state);
    console.warn(`[Bootstrap] ${category} (${phase || '-'}): ${state.error}`);
    return state;
}

async function applyTenantKeyResponse(json, ncInstanceId) {
    config.tenantKey = json.tenantKey;
    config.organizationId = json.organizationId;
    config.ncInstanceId = ncInstanceId;
    await writeCache({
        tenantKey: json.tenantKey,
        organizationId: json.organizationId,
        organizationName: json.organizationName,
        ncInstanceId,
        ncVersion: json.ncVersion,
        // Pin: remember which Bee Flow server provisioned this org so a later
        // change to the default/picker URL can't silently repoint the connector
        // and mint a second org elsewhere. Only an explicit reset
        // (invalidateAndRebootstrap) drops this by deleting the cache.
        boundApiBaseUrl: config.apiBaseUrl,
        provisionedAt: new Date().toISOString(),
    });
    await deletePendingFile();
    pendingState = null;
}

// Poll the SaaS for an approved binding. Spawned in the background when the
// bootstrap returns 202; returns once the binding is approved (and the
// tenant key is cached) or denied/expired (gives up). The connector keeps
// running with no tenant key in the meantime — heartbeat surfaces this.
async function pollPendingBinding(pending) {
    const stopAt = new Date(pending.expiresAt).getTime() + POLL_GRACE_AFTER_EXPIRY_MS;
    pendingState = {
        pendingId: pending.pendingId,
        pollUrl: pending.pollUrl,
        expiresAt: pending.expiresAt,
        status: 'pending',
    };
    while (Date.now() < stopAt) {
        const wait = POLL_INTERVAL_MS + Math.floor((Math.random() * 2 - 1) * POLL_JITTER_MS);
        await new Promise(r => setTimeout(r, Math.max(5_000, wait)));
        let res;
        try {
            res = await fetch(`${config.apiBaseUrl}${pending.pollUrl}`, {
                signal: AbortSignal.timeout(10_000),
            });
        } catch (e) {
            console.warn(`[Bootstrap] Poll failed (will retry): ${e.message}`);
            continue;
        }
        if (res.status === 202) continue;
        if (res.status === 410) {
            const body = await res.json().catch(() => ({}));
            console.warn(`[Bootstrap] Pending binding ${body.status || 'denied/expired'} — abandoning poll`);
            pendingState = { ...pendingState, status: body.status || 'denied' };
            await deletePendingFile();
            return;
        }
        if (res.ok) {
            const json = await res.json();
            if (!json.tenantKey) {
                console.warn('[Bootstrap] Pending poll returned 200 without tenantKey — retrying');
                continue;
            }
            await applyTenantKeyResponse(json, pending.ncInstanceId);
            console.log(`[Bootstrap] Bound to existing org ${json.organizationId} (${json.organizationName})`);
            return;
        }
        // 4xx/5xx other than 202/410 — keep trying with backoff, capped.
        console.warn(`[Bootstrap] Poll HTTP ${res.status}, retrying`);
    }
    console.warn('[Bootstrap] Pending binding poll window elapsed — giving up');
    pendingState = { ...pendingState, status: 'expired' };
    await deletePendingFile();
}

// Resolve the in-flight verification pending from memory (preferred) or disk.
async function currentVerificationPending() {
    if (pendingState && pendingState.status === 'awaiting_email_verification') return pendingState;
    const fromDisk = await readPendingFile();
    if (fromDisk && (fromDisk.kind === 'verification' || fromDisk.verifyUrl)) return fromDisk;
    return null;
}

// Submit the emailed code to the SaaS. On success the tenant key is cached and
// the connector becomes fully operational. Throws a structured error (with
// `code` and, for a wrong code, `attemptsLeft`) the SPA can render. Called from
// the connector-owned /setup/verify-email-code route.
async function submitVerificationCode(code) {
    const pending = await currentVerificationPending();
    if (!pending || !pending.verifyUrl) {
        const e = new Error('No pending Nextcloud verification to confirm');
        e.code = 'no_pending';
        throw e;
    }
    let res;
    try {
        res = await fetch(`${config.apiBaseUrl}${pending.verifyUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(code || '').trim() }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to verify the code: ${e.message}`);
        err.code = 'saas_unreachable';
        throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.tenantKey) {
        await applyTenantKeyResponse(json, pending.ncInstanceId);
        await clearErrorFile();
        console.log(`[Bootstrap] Email verification succeeded — bound to org ${json.organizationId} (${json.organizationName})`);
        return { ok: true, organizationId: json.organizationId, organizationName: json.organizationName };
    }
    const err = new Error(json.error || `Verification failed (HTTP ${res.status})`);
    err.code = json.code || 'verify_failed';
    err.status = res.status;
    if (typeof json.attemptsLeft === 'number') err.attemptsLeft = json.attemptsLeft;
    throw err;
}

// Ask the SaaS to email a fresh code (attempts reset, TTL extended). Updates the
// stored pending state with the new expiry. Called from /setup/resend-email-code.
async function resendVerificationCode() {
    const pending = await currentVerificationPending();
    if (!pending || !pending.resendUrl) {
        const e = new Error('No pending Nextcloud verification to resend');
        e.code = 'no_pending';
        throw e;
    }
    let res;
    try {
        res = await fetch(`${config.apiBaseUrl}${pending.resendUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to resend the code: ${e.message}`);
        err.code = 'saas_unreachable';
        throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
        const updated = {
            ...pending,
            expiresAt: json.expiresAt || pending.expiresAt,
            maskedEmail: json.maskedEmail || pending.maskedEmail,
            emailSent: json.emailSent !== false,
        };
        pendingState = { status: 'awaiting_email_verification', ...updated };
        await writePendingFile(updated);
        return { ok: true, maskedEmail: updated.maskedEmail, expiresAt: updated.expiresAt, emailSent: updated.emailSent };
    }
    const err = new Error(json.error || `Resend failed (HTTP ${res.status})`);
    err.code = json.code || 'resend_failed';
    err.status = res.status;
    throw err;
}

// Single-flight guard. bootstrapIfNeeded() is called from boot (server.js), the
// /init lifecycle hook (heartbeat.js), the declarative-settings poll, and the
// /setup/* routes. Because the tenant-key cache isn't written until a provision
// completes, several of these fire CONCURRENTLY on a fresh install — the
// connector was sending ~5 parallel "provision from SaaS" POSTs, which against a
// multi-replica SaaS minted divergent tenant keys, so the connector cached a
// different key than the SaaS stored and every per-user JWT 403'd. Collapsing
// all concurrent callers onto one in-flight run means exactly one provision (one
// mint) happens; once it caches the key, later calls take the fast cached path.
let _bootstrapInFlight = null;
function bootstrapIfNeeded() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try { return await _provisionFlow(); }
        finally { _bootstrapInFlight = null; }
    })();
    return _bootstrapInFlight;
}

async function _provisionFlow() {
    if (!config.isAutoTenantKey) {
        console.log('[Bootstrap] BEEFLOW_TENANT_KEY explicitly set, skipping auto-bootstrap');
        return;
    }

    const cached = await readCache();
    if (cached?.tenantKey) {
        config.tenantKey = cached.tenantKey;
        config.organizationId = cached.organizationId || null;
        config.ncInstanceId = cached.ncInstanceId || null;
        // Pin to the server this org was provisioned on. A changed default (or
        // picker) URL must not silently move a bound connector to a different
        // Bee Flow server — that would mint a second org there. An explicit
        // BEEFLOW_API_BASE_URL env override still wins (deliberate admin lock);
        // only an explicit reset (setup picker → invalidateAndRebootstrap, which
        // deletes the cache) drops the pin.
        if (cached.boundApiBaseUrl && !process.env.BEEFLOW_API_BASE_URL) {
            if (config.apiBaseUrl !== cached.boundApiBaseUrl) {
                console.warn(`[Bootstrap] Pinning to bound server ${cached.boundApiBaseUrl} (ignoring configured ${config.apiBaseUrl})`);
            }
            config.apiBaseUrl = cached.boundApiBaseUrl;
        }
        await clearErrorFile();
        console.log(`[Bootstrap] Loaded cached tenant key for org ${cached.organizationId}`);
        return;
    }

    // Hydrate last-error state from disk so a container restart can
    // surface the previous failure until the next bootstrap attempt
    // either resolves or refreshes it.
    if (!lastErrorState) {
        lastErrorState = await readErrorFile();
    }

    // Resume an in-flight pending binding instead of starting a new one —
    // covers connector restart inside the approval window.
    const existingPending = await readPendingFile();
    if (existingPending) {
        const expiresMs = new Date(existingPending.expiresAt).getTime();
        const stillValid = Number.isFinite(expiresMs) && Date.now() < expiresMs + POLL_GRACE_AFTER_EXPIRY_MS;
        if (stillValid && (existingPending.kind === 'verification' || existingPending.verifyUrl)) {
            // Email-code verification waits on the admin entering the code in
            // the embedded view — restore the state so the SPA re-renders the
            // verification screen. No polling: the user action drives it.
            pendingState = { status: 'awaiting_email_verification', ...existingPending };
            console.log(`[Bootstrap] Resuming email verification ${existingPending.pendingId}`);
            return;
        }
        if (stillValid && existingPending.pollUrl) {
            console.log(`[Bootstrap] Resuming pending binding ${existingPending.pendingId} (awaiting admin approval)`);
            pollPendingBinding(existingPending).catch(e => console.warn('[Bootstrap] Pending poll crashed:', e.message));
            return;
        }
        await deletePendingFile();
    }

    console.log('[Bootstrap] No cached tenant key; provisioning from SaaS...');

    let caps, admin;
    try {
        caps = await fetchCapabilities();
    } catch (err) {
        await recordBootstrapError(err, 'capabilities');
        throw err;
    }
    try {
        admin = await fetchFirstAdmin();
    } catch (err) {
        await recordBootstrapError(err, 'admin');
        throw err;
    }

    // Where the SaaS will reach this connector for runtime callbacks (the
    // /nc/* HMAC-signed reverse proxy used by every SaaS→NC operation:
    // user sync, file fetches, group lookups, etc.). MUST be publicly
    // reachable from the SaaS host. Pattern: route through NC's AppAPI
    // proxy (^nc/.* is declared PUBLIC in info.xml), so the URL is
    // `<NC-public-base>/index.php/apps/app_api/proxy/<appId>`. AppAPI
    // forwards to the connector's /nc/* paths with no per-user auth, and
    // the connector verifies the SaaS's HMAC. Falls back to nextcloudUrl
    // when no public URL is configured (production NC App Store installs
    // already have publicly-reachable NC hostnames; only the local Docker
    // sandbox needs `BEEFLOW_NC_PUBLIC_URL` to point at a tunnel).
    const ncBase = config.nextcloudPublicUrl || config.nextcloudUrl;
    const connectorCallbackUrl = `${ncBase}/index.php/apps/app_api/proxy/${config.appId}`;

    let res;
    try {
        const headers = {
            'Content-Type': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': caps.instanceId,
            'X-Beeflow-NC-Base-Url': config.nextcloudPublicUrl || config.nextcloudUrl,
            'X-Beeflow-NC-Admin-Uid': admin.uid,
            'X-Beeflow-NC-Admin-Email': admin.email,
            'X-Beeflow-NC-Admin-Display-Name': admin.displayName,
            'X-Beeflow-Connector-Callback-Url': connectorCallbackUrl,
        };
        // Pairing-code branch: when the admin has handed us a code via env
        // var, attach it. SaaS will redeem + bind to the existing org instead
        // of falling through to email-match or fresh-org. The code is single-
        // use; if the request returns OK we wipe the env var below so a
        // restart doesn't re-redeem against a now-invalid code.
        if (config.pairingCode) {
            headers['X-Beeflow-Pairing-Code'] = config.pairingCode;
            console.log(`[Bootstrap] Attaching pairing code ${config.pairingCode.slice(0, 4)}*** for redemption`);
        }
        res = await fetch(`${config.apiBaseUrl}/auth/connector/bootstrap`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ themingName: caps.themingName, version: caps.version }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        // Network-level failure (DNS, refused, timeout). Distinct from a
        // SaaS HTTP error which is handled below.
        await recordBootstrapError(err, 'saas_post');
        throw err;
    }

    if (res.status === 202) {
        const json = await res.json();
        // Same-domain match — confirm via an emailed code entered in the
        // embedded view. No polling: the connector waits for the admin to
        // submit the code through /setup/verify-email-code, which calls
        // submitVerificationCode() below.
        if (json.code === 'email_verification_required') {
            if (!json.pendingId || !json.verifyUrl) {
                const e = new Error('Bootstrap verification response missing pendingId/verifyUrl');
                await recordBootstrapError(e, 'saas_response');
                throw e;
            }
            const pending = {
                kind: 'verification',
                pendingId: json.pendingId,
                verifyUrl: json.verifyUrl,
                resendUrl: json.resendUrl,
                retargetUrl: json.retargetUrl,
                expiresAt: json.expiresAt,
                maskedEmail: json.maskedEmail || null,
                organizationName: json.organizationName || null,
                ncInstanceId: caps.instanceId,
            };
            await writePendingFile(pending);
            pendingState = { status: 'awaiting_email_verification', ...pending };
            await clearErrorFile(); // verification is a valid in-flight state
            console.log(`[Bootstrap] Awaiting email verification (pending ${json.pendingId}, code sent to ${json.maskedEmail})`);
            return;
        }
        // Adoption candidate — admin approval required (legacy). Stash poll
        // state and let the connector continue running; the poller fills in
        // the tenant key once the admin approves in the SaaS UI.
        if (!json.pendingId || !json.pollUrl) {
            const e = new Error('Bootstrap pending response missing pendingId/pollUrl');
            await recordBootstrapError(e, 'saas_response');
            throw e;
        }
        const pending = {
            pendingId: json.pendingId,
            pollUrl: json.pollUrl,
            expiresAt: json.expiresAt,
            ncInstanceId: caps.instanceId,
        };
        await writePendingFile(pending);
        console.log(`[Bootstrap] Awaiting org-admin approval (pending ${json.pendingId}, expires ${json.expiresAt})`);
        await clearErrorFile(); // pending is a valid in-flight state, not a failure
        pollPendingBinding(pending).catch(e => console.warn('[Bootstrap] Pending poll crashed:', e.message));
        return;
    }

    if (!res.ok) {
        // Parse a structured SaaS response when present. The new server-side
        // contract returns { error, code, remediation } so we can map to the
        // right heartbeat category without string-matching the message.
        const errBody = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(errBody); } catch (_) { /* not JSON */ }
        const msg = parsed?.error || errBody.slice(0, 200);
        const e = new Error(`Bootstrap rejected by SaaS (HTTP ${res.status}): ${msg}`);
        if (parsed?.code) e.code = parsed.code;
        if (parsed?.remediation) e.remediation = parsed.remediation;
        await recordBootstrapError(e, 'saas_post', { remediation: parsed?.remediation });
        throw e;
    }
    const json = await res.json();
    if (!json.tenantKey) {
        const e = new Error('Bootstrap response missing tenantKey');
        await recordBootstrapError(e, 'saas_response');
        throw e;
    }

    await applyTenantKeyResponse({ ...json, ncVersion: caps.version }, caps.instanceId);
    await clearErrorFile();
    // If we redeemed a pairing code, clear it from runtime config so a
    // restart can't try to redeem it again (the SaaS will reject it on a
    // second attempt anyway, but better to fail closed before the request).
    if (config.pairingCode) {
        console.log('[Bootstrap] Pairing code redeemed — clearing for future restarts');
        config.pairingCode = null;
    }
    console.log(`[Bootstrap] Provisioned org ${json.organizationId} (${json.organizationName}) — tenant key cached`);
}

/**
 * Drop the cached tenant key + any in-flight pending binding, clear the
 * in-memory tenant key on `config`, and run a fresh bootstrap. Used by the
 * setup picker when the user flips between Bee Flow Cloud and a
 * self-hosted server — the existing key is for a different SaaS and would
 * be rejected.
 *
 * Best-effort: errors are caught + logged, never thrown to the caller.
 */
async function invalidateAndRebootstrap({ pairingCode } = {}) {
    // Snapshot the previous working state so we can roll back if the new
    // target's bootstrap fails. Without this, a typo in the settings panel
    // (or a Cloud-mode pick from a localhost-only NC sandbox) wipes the
    // working tenant key and strands the connector with 502 "Tenant key not
    // configured" until something else fixes it.
    const prev = {
        tenantKey: config.tenantKey,
        organizationId: config.organizationId,
        ncInstanceId: config.ncInstanceId,
        cacheFile: null,
        pairingCode: config.pairingCode,
    };
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        prev.cacheFile = await fs.readFile(cachePath, 'utf8').catch(() => null);
    } catch (_) { /* tolerate */ }

    try {
        await fs.unlink(cachePath).catch(() => {});
        await deletePendingFile();
        config.tenantKey = null;
        config.organizationId = null;
        config.ncInstanceId = null;
        if (pairingCode) {
            config.pairingCode = pairingCode;
        }
        console.log('[Bootstrap] Invalidated cached tenant key after setup change — re-bootstrapping');
        // Explicit admin reset must force a fresh provision, not piggy-back on an
        // in-flight one (which may be mid-bind to the old target / without the
        // pairing code). Clearing the single-flight guard is safe here: the SaaS
        // mint is atomic, so even if this races a boot-time provision both
        // converge on the same key.
        _bootstrapInFlight = null;
        await bootstrapIfNeeded();
        if (!config.tenantKey) {
            // bootstrapIfNeeded swallows network errors and just logs; if we
            // got back here without a key, the new target is unreachable.
            throw new Error('bootstrap completed without producing a tenant key');
        }
    } catch (err) {
        console.warn(`[Bootstrap] re-bootstrap failed (${err.message}); rolling back to previous tenant key`);
        config.tenantKey = prev.tenantKey;
        config.organizationId = prev.organizationId;
        config.ncInstanceId = prev.ncInstanceId;
        config.pairingCode = prev.pairingCode;
        if (prev.cacheFile) {
            await fs.writeFile(cachePath, prev.cacheFile, { mode: 0o600 }).catch(() => {});
        }
        throw err;
    }
}

// Is this NC uid in the admin group? Gates the in-app verification request so
// only an admin can drive pairing.
async function isNcAdmin(uid) {
    try {
        const info = await fetchUserInfo(uid);
        const groups = info?.groups || [];
        return Array.isArray(groups) && groups.includes('admin');
    } catch { return false; }
}

// Send the verification code to the admin actually performing setup (the current
// NC user in the embedded view) by re-pointing the pending binding at them — so
// the code reaches the right person and they become the org admin on success.
// Returns { maskedEmail, expiresAt, emailSent } or throws a structured error.
async function requestVerificationCode({ uid, email, displayName }) {
    const pending = await currentVerificationPending();
    if (!pending) {
        const e = new Error('No pending Nextcloud verification');
        e.code = 'no_pending';
        throw e;
    }
    const retargetUrl = pending.retargetUrl || `/auth/connector/bootstrap/pending/${pending.pendingId}/retarget`;
    let res;
    try {
        res = await fetch(`${config.apiBaseUrl}${retargetUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, uid, displayName }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to send the code: ${e.message}`);
        err.code = 'saas_unreachable';
        throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
        const updated = {
            ...pending,
            maskedEmail: json.maskedEmail || pending.maskedEmail,
            expiresAt: json.expiresAt || pending.expiresAt,
        };
        pendingState = { status: 'awaiting_email_verification', ...updated };
        await writePendingFile(updated);
        return { ok: true, maskedEmail: updated.maskedEmail, expiresAt: updated.expiresAt, emailSent: json.emailSent !== false };
    }
    const err = new Error(json.error || `Could not send the code (HTTP ${res.status})`);
    err.code = json.code || 'request_failed';
    err.status = res.status;
    throw err;
}

module.exports = {
    bootstrapIfNeeded,
    fetchCapabilities,
    getPendingState,
    getLastErrorState,
    remediationFor,
    invalidateAndRebootstrap,
    submitVerificationCode,
    resendVerificationCode,
    requestVerificationCode,
    isNcAdmin,
    stableInstanceIdFallback,
    ncHostFromUrl,
};
