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
        console.log(`[Bootstrap] Loaded cached tenant key for org ${cached.organizationId}`);
        return;
    }

    console.log('[Bootstrap] No cached tenant key; provisioning from SaaS...');
    const caps = await fetchCapabilities();
    const admin = await fetchFirstAdmin();

    const connectorCallbackUrl = `http://${process.env.HOSTNAME || 'nc_app_' + config.appId}:${config.appPort}`;
    const res = await fetch(`${config.apiBaseUrl}/auth/connector/bootstrap`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': caps.instanceId,
            'X-Beeflow-NC-Base-Url': config.nextcloudUrl,
            'X-Beeflow-NC-Admin-Uid': admin.uid,
            'X-Beeflow-NC-Admin-Email': admin.email,
            'X-Beeflow-NC-Admin-Display-Name': admin.displayName,
            'X-Beeflow-Connector-Callback-Url': connectorCallbackUrl,
        },
        body: JSON.stringify({ themingName: caps.themingName, version: caps.version }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Bootstrap rejected by SaaS (HTTP ${res.status}): ${errBody.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.tenantKey) throw new Error('Bootstrap response missing tenantKey');

    config.tenantKey = json.tenantKey;
    config.organizationId = json.organizationId;
    config.ncInstanceId = caps.instanceId;
    await writeCache({
        tenantKey: json.tenantKey,
        organizationId: json.organizationId,
        organizationName: json.organizationName,
        ncInstanceId: caps.instanceId,
        ncVersion: caps.version,
        provisionedAt: new Date().toISOString(),
    });
    console.log(`[Bootstrap] Provisioned org ${json.organizationId} (${json.organizationName}) — tenant key cached`);
}

module.exports = { bootstrapIfNeeded, fetchCapabilities };
