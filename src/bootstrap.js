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

const CACHE_FILE = 'tenant-key.json';
const PENDING_FILE = 'pending-bootstrap.json';
const ERROR_FILE = 'bootstrap-last-error.json';
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 5_000;
const POLL_GRACE_AFTER_EXPIRY_MS = 5 * 60_000;

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
        if (parsed?.pendingId && parsed?.pollUrl) return parsed;
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
    const instanceId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid
        || `${data?.version?.string || 'nc'}:${themingName}`;
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
    const res = await fetch(url, {
        headers: await appApiOcsHeaders(''),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`AppAPI users list HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.ocs?.data;
    if (!Array.isArray(data)) throw new Error('Unexpected users-list payload');
    return data;
}

async function fetchUserInfo(uid) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const res = await fetch(url, {
        headers: await appApiOcsHeaders(uid),
        signal: AbortSignal.timeout(10_000),
    });
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

async function fetchFirstAdmin() {
    // Fast path: ask NC for the admin-group membership directly. One round-
    // trip instead of `fetchAllUids` + N × `fetchUserInfo` (which on a 100-
    // user instance was up to 1000s).
    const adminUids = await fetchAdminUidsViaGroup();
    if (adminUids) {
        const uid = adminUids[0];
        const info = await fetchUserInfo(uid);
        return {
            uid,
            email: info?.email || `${uid}@example.local`,
            displayName: info?.displayname || info?.['display-name'] || uid,
        };
    }

    // Slow-path fallback: AppAPI version doesn't expose /cloud/groups/admin/users.
    // Walk the user list in parallel batches of 5 instead of one-by-one.
    const uids = await fetchAllUids();
    if (uids.length === 0) throw new Error('No NC users visible to the ExApp');
    let firstAny = null;
    const BATCH_SIZE = 5;
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);
        const infos = await Promise.all(batch.map(uid =>
            fetchUserInfo(uid).then(info => ({ uid, info })).catch(() => ({ uid, info: null }))
        ));
        for (const { uid, info } of infos) {
            if (!info) continue;
            if (!firstAny) firstAny = { uid, info };
            const groups = info.groups || [];
            if (groups.includes('admin')) {
                return {
                    uid,
                    email: info.email || `${uid}@example.local`,
                    displayName: info.displayname || info['display-name'] || uid,
                };
            }
        }
    }
    // Fallback: no admin group reported — use first user. This is a fresh
    // install corner case; the chosen user becomes the Bee Flow org_admin.
    if (firstAny) {
        return {
            uid: firstAny.uid,
            email: firstAny.info.email || `${firstAny.uid}@example.local`,
            displayName: firstAny.info.displayname || firstAny.info['display-name'] || firstAny.uid,
        };
    }
    throw new Error('Could not determine NC admin from user list');
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
    saas_auth_rejected:
        'The Bee Flow service rejected our credentials. Check that this NC instance has not been disabled in your Bee Flow organisation.',
    tenant_already_provisioned:
        'This Nextcloud was bootstrapped previously and the tenant-key cache was lost. Recover the key from the Bee Flow admin UI, then set BEEFLOW_TENANT_KEY via `occ app_api:app:setenv`.',
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
};

// Categorise a thrown error into one of the well-known buckets that the
// SPA's error overlay knows how to render. Prefers a structured `code`
// set on the error (from a parsed SaaS response) and falls back to
// message inspection. Anything we don't recognise falls through as
// `unknown` — still surfaced, just without specific remediation copy.
function categoriseError(err, phase) {
    if (err?.code && SAAS_CODE_TO_CATEGORY[err.code]) return SAAS_CODE_TO_CATEGORY[err.code];
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

async function bootstrapIfNeeded() {
    if (!config.isAutoTenantKey) {
        console.log('[Bootstrap] BEEFLOW_TENANT_KEY explicitly set, skipping auto-bootstrap');
        return;
    }

    const cached = await readCache();
    if (cached?.tenantKey) {
        config.tenantKey = cached.tenantKey;
        config.organizationId = cached.organizationId || null;
        config.ncInstanceId = cached.ncInstanceId || null;
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
        if (Number.isFinite(expiresMs) && Date.now() < expiresMs + POLL_GRACE_AFTER_EXPIRY_MS) {
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
        // Adoption candidate — admin approval required. Stash poll state
        // and let the connector continue running; the poller will fill in
        // the tenant key once the admin approves in the SaaS UI.
        const json = await res.json();
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

module.exports = {
    bootstrapIfNeeded,
    fetchCapabilities,
    getPendingState,
    getLastErrorState,
    remediationFor,
    invalidateAndRebootstrap,
};
