const log = require('./log');
/**
 * One-click bootstrap: turn a fresh ExApp install into a fully-configured
 * Bee Flow tenant without the NC admin having to paste anything.
 *
 * Triggered from server.js on startup (and again on /init lifecycle if cache
 * is missing). Behaviour:
 *
 *   0. If no Bee Flow server is chosen (config.apiBaseUrl is null) → nothing
 *      happens: no file is read, Nextcloud is not asked for its administrators
 *      and no request leaves. The flow starts when an administrator chooses a
 *      server (serverChoice.js).
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
const { writeFileAtomic } = require('./atomicWrite');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');
// ncHostFromUrl and stableInstanceIdFallback are the server's own code: src/shared/orgNaming.js is
// generated from server/auth/orgNaming.js (npm run gen:shared), so the instance id the connector
// sends is, by construction, the one the server re-derives.
const { ncHostFromUrl, stableInstanceIdFallback } = require('./shared/orgNaming');
const { errMessage, errCode, errText } = require('./errors');
const { notChosenError, CLOUD_API_BASE_URL } = require('./serverChoice');
const { isCertificateError } = require('./serverProbe');

/**
 * The part of an OCS user record the bootstrap reads.
 * @typedef {{ email?: string, displayname?: string, 'display-name'?: string, groups?: string[] }} NcUserInfo
 * @typedef {{ uid: string, email: string, displayName: string }} NcAdmin
 * @typedef {{ instanceId: string, themingName: string, version: string }} NcCapabilities
 *
 * A pending binding, as kept in memory and in pending-bootstrap.json: either "an org admin has to
 * approve" (pollUrl) or "the admin has to type the emailed code" (verifyUrl and friends).
 * @typedef {object} PendingBinding
 * @property {string} [pendingId]
 * @property {'verification'} [kind]
 * @property {string} [pollUrl]
 * @property {string} [verifyUrl]
 * @property {string} [resendUrl]
 * @property {string} [retargetUrl]
 * @property {string} [expiresAt]
 * @property {string | null} [maskedEmail]
 * @property {string | null} [organizationName]
 * @property {boolean} [emailSent]
 * @property {string} [ncInstanceId]
 * @property {string} [apiBaseUrl]  the Bee Flow server that issued it: verify, resend and retarget go there
 * @typedef {PendingBinding & { status: string }} PendingState  what heartbeat and /setup/diagnostics show
 *
 * What /auth/connector/bootstrap and its pending/verify/resend/retarget routes answer. The SaaS
 * decides which fields are present; every one is optional here.
 * @typedef {object} SaasBootstrapResponse
 * @property {string} [tenantKey]
 * @property {string} [organizationId]
 * @property {string} [organizationName]
 * @property {string} [ncVersion]
 * @property {string} [code]
 * @property {string} [error]
 * @property {string} [status]
 * @property {boolean} [ok]
 * @property {string} [pendingId]
 * @property {string} [pollUrl]
 * @property {string} [verifyUrl]
 * @property {string} [resendUrl]
 * @property {string} [retargetUrl]
 * @property {string} [expiresAt]
 * @property {string} [maskedEmail]
 * @property {boolean} [emailSent]
 * @property {number} [attemptsLeft]
 *
 * What readCache / writeCache keep in tenant-key.json.
 * @typedef {object} TenantCache
 * @property {string} tenantKey
 * @property {string} [organizationId]
 * @property {string} [organizationName]
 * @property {string} [ncInstanceId]
 * @property {string} [ncVersion]
 * @property {string} [boundApiBaseUrl]
 * @property {string} [provisionedAt]
 *
 * @typedef {'saas_post' | 'saas_response' | 'capabilities' | 'admin'} BootstrapPhase
 * @typedef {object} BootstrapErrorState
 * @property {'failed'} status
 * @property {string} category
 * @property {string} phase
 * @property {string} error
 * @property {string | null} remediation
 * @property {string} lastAttemptAt
 * @property {string | null} nextRetryAt  null when no automatic retry is scheduled
 */

const CACHE_FILE = 'tenant-key.json';
const PENDING_FILE = 'pending-bootstrap.json';
const ERROR_FILE = 'bootstrap-last-error.json';
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 5_000;
const POLL_GRACE_AFTER_EXPIRY_MS = 5 * 60_000;
// A failed first bootstrap (Bee Flow server down, egress blocked, DNS not
// ready) is retried on its own: AppAPI only calls /init on install and
// upgrade, so without this the connector stayed keyless until a restart.
// First delay, doubling per failure up to BOOTSTRAP_RETRY_MAX_MS; 0 = off.
const BOOTSTRAP_RETRY_MS = parseInt(process.env.BEEFLOW_BOOTSTRAP_RETRY_MS || '60000', 10);
const BOOTSTRAP_RETRY_MAX_MS = 15 * 60_000;

/**
 * @returns {Promise<TenantCache | null>}
 */
async function readCache() {
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        const raw = await fs.readFile(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.tenantKey) return parsed;
    } catch { /* missing or unreadable */ }
    return null;
}

/**
 * @param {TenantCache} data
 */
async function writeCache(data) {
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        await fs.mkdir(config.persistentStorage, { recursive: true });
        await writeFileAtomic(cachePath, JSON.stringify(data, null, 2));
    } catch (e) {
        log.warn(`[Bootstrap] Could not persist tenant key to ${cachePath}: ${errMessage(e)}`);
    }
}

/**
 * @returns {Promise<PendingBinding | null>}
 */
async function readPendingFile() {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.pendingId && (parsed?.pollUrl || parsed?.verifyUrl)) return parsed;
    } catch { /* missing */ }
    return null;
}

/**
 * @param {PendingBinding} data
 */
async function writePendingFile(data) {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try {
        await fs.mkdir(config.persistentStorage, { recursive: true });
        await writeFileAtomic(p, JSON.stringify(data, null, 2));
    } catch (e) {
        log.warn(`[Bootstrap] Could not persist pending state to ${p}: ${errMessage(e)}`);
    }
}

async function deletePendingFile() {
    const p = path.join(config.persistentStorage, PENDING_FILE);
    try { await fs.unlink(p); } catch (_) { /* gone */ }
}

/**
 * `ocs.data` of /cloud/capabilities, reduced to what is read.
 * @typedef {{ version?: { string?: string }, capabilities?: { theming?: { name?: string, instanceid?: string }, core?: { instanceid?: string } } }} NcCapabilitiesData
 */

/**
 * @returns {Promise<NcCapabilities>}
 */
async function fetchCapabilities() {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/capabilities?format=json`;
    const res = await fetch(url, {
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`NC capabilities HTTP ${res.status}`);
    const body = /** @type {{ ocs?: { data?: NcCapabilitiesData } } | null} */ (await res.json());
    const data = body?.ocs?.data;
    if (!data?.version) throw new Error('NC capabilities missing version data');
    const themingName = data?.capabilities?.theming?.name || 'Nextcloud';
    let instanceId = data?.capabilities?.theming?.instanceid
        || data?.capabilities?.core?.instanceid;
    if (!instanceId) {
        // This is the normal case, not an exception: Nextcloud 32-35 publishes
        // no instance id in its capabilities (OC\OCS\CoreCapabilities has
        // pollinterval, webdav-root, reference-api, reference-regex and
        // mod-rewrite-working; the theming capabilities have none either), so
        // the two reads above only ever match a server that adds one.
        // Derive the id from the public base URL host (the same value we send
        // as X-Beeflow-NC-Base-Url and that the SaaS re-derives) so it doesn't
        // change when NC is upgraded — which would otherwise create a duplicate
        // org on the next re-bootstrap. It DOES change when that host changes;
        // the cached tenant key file keeps the id it was bootstrapped with.
        instanceId = stableInstanceIdFallback(config.nextcloudPublicUrl || config.nextcloudUrl, themingName);
        log.info(`[Bootstrap] Nextcloud publishes no instance id in its capabilities; using the host-derived id '${instanceId}'`);
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
/**
 * @param {string} [asUid]
 * @returns {Promise<Record<string, string>>}
 */
async function appApiOcsHeaders(asUid = '') {
    return {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'AUTHORIZATION-APP-API': Buffer.from(`${asUid}:${config.appSecret}`).toString('base64'),
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
    };
}

/**
 * @returns {Promise<string[]>}
 */
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
    const body = /** @type {{ ocs?: { data?: unknown } } | null} */ (await res.json());
    const data = body?.ocs?.data;
    if (!Array.isArray(data)) throw new Error('Unexpected users-list payload');
    return data;
}

/**
 * @param {string} uid
 * @returns {Promise<NcUserInfo | null>}
 */
async function fetchUserInfo(uid) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const headers = await appApiOcsHeaders(uid);
    const res = await withWarmupRetry(() => fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
    }), { label: 'user-info', budgetMs: 30_000 });
    if (!res.ok) return null;
    const body = /** @type {{ ocs?: { data?: NcUserInfo } } | null} */ (await res.json());
    return body?.ocs?.data || null;
}

/**
 * @returns {Promise<string[] | null>}
 */
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
        const body = /** @type {{ ocs?: { data?: { users?: unknown } } } | null} */ (await res.json());
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

/**
 * @param {string} uid
 * @param {NcUserInfo} info
 * @returns {NcAdmin | null}  null when the user has no email address
 */
function pickAdmin(uid, info) {
    const email = info.email;
    if (!email) return null;
    return {
        uid,
        email,
        displayName: info.displayname || info['display-name'] || uid,
    };
}

// Discover EVERY NC admin (member of the built-in `admin` group) that has a
// real email — so the SaaS can provision them all as Bee Flow org_admins and
// any admin (not just the one who installed) can onboard/use Bee Flow. Only
// full `admin`-group members can install ExApps, so this group is the correct,
// complete signal. The returned array is sorted by uid for a stable "primary"
// (entry 0 — carried in the X-Beeflow-NC-Admin-* headers + pinned as the org's
// nc_admin_uid). Never synthesise an email.
/**
 * @returns {Promise<NcAdmin[]>}
 */
async function fetchAdmins() {
    /** @type {NcAdmin[]} */
    const out = [];

    // Fast path: ask NC for the admin-group membership directly, then fetch
    // each member's info (the admin group is small — a handful of users — so
    // the N lookups here are cheap, unlike walking every user in the slow path).
    const adminUids = await fetchAdminUidsViaGroup();
    if (adminUids) {
        for (const uid of adminUids) {
            const info = await fetchUserInfo(uid);
            const admin = info ? pickAdmin(uid, info) : null;
            if (admin) out.push(admin);
        }
        // Admin group resolved but no member has an email — can't reliably
        // link to a Bee Flow account.
        if (out.length === 0) throw adminNoEmailError();
        return out.sort((a, b) => a.uid.localeCompare(b.uid));
    }

    // Nextcloud answers the group lookup above only where it accepts an app
    // that acts without a user; where it refuses (current Nextcloud versions
    // do), the administrators are found here: the user list is walked in
    // parallel batches of 5 and each record is read locally for its groups.
    // Only the administrators' names and addresses are sent on.
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
                const admin = pickAdmin(uid, info);
                if (admin) out.push(admin);
                else sawAdminWithoutEmail = true;
            }
        }
    }
    if (out.length === 0) {
        if (sawAdminWithoutEmail) throw adminNoEmailError();
        throw new Error('Could not determine an NC admin with an email address');
    }
    return out.sort((a, b) => a.uid.localeCompare(b.uid));
}

// Pending-state runtime visibility — heartbeat.js reads this to surface
// "awaiting admin approval" through AppAPI's ExApp status.
/** @type {PendingState | null} */
let pendingState = null;
/**
 * @returns {PendingState | null}
 */
function getPendingState() { return pendingState; }

// Last-error visibility — heartbeat.js + /setup/diagnostics surface this so
// the NC admin sees a categorised, actionable failure (with remediation
// text) instead of a silent stuck bootstrap. Cleared on success.
//
// REMEDIATION lives here (single source of truth) so heartbeat.js and
// setup.js can both consume it without drifting.
// The entries that name the Bee Flow server are functions: they name the
// server this connector is configured for, read when the text is asked for.
/**
 * The Bee Flow server this connector is on, as a failure text names it.
 * @returns {string}
 */
function serverLabel() {
    if (!config.apiBaseUrl) return 'The Bee Flow server';
    if (config.apiBaseUrl === CLOUD_API_BASE_URL) return 'Bee Flow Cloud';
    return `Your Bee Flow server (${config.apiBaseUrl})`;
}

/** @type {Record<string, string | (() => string)>} */
const REMEDIATION = {
    saas_cert_untrusted:
        'The certificate of your Bee Flow server is not trusted by the connector. Give the server a certificate from a public certificate authority, or put the certificate of your own certificate authority (PEM) in the install-time value BEEFLOW_SERVER_CA_CERT. Certificate verification cannot be switched off.',
    saas_unreachable: () =>
        `Your Bee Flow server is not reachable from this Nextcloud. Test with \`curl ${config.apiBaseUrl || '<your Bee Flow server>'}/api/health\` from the connector container and allow that hostname in your egress firewall.`,
    // The Bee Flow server could not call this Nextcloud back. What helps
    // depends on the server: Bee Flow Cloud calls from the internet, a server
    // of the administrator's own can be told to call a private address.
    nc_not_publicly_reachable: () => {
        const address = config.nextcloudPublicUrl || config.nextcloudUrl;
        if (!config.apiBaseUrl) {
            return 'The Bee Flow server cannot reach this Nextcloud at the address the connector reports. Set an address the server can reach as the public Nextcloud URL on the Bee Flow setup page.';
        }
        if (config.apiBaseUrl === CLOUD_API_BASE_URL) {
            return `Bee Flow Cloud cannot reach this Nextcloud at the address the connector reports (${address}). Bee Flow Cloud needs a Nextcloud that is reachable from the internet, directly or through a tunnel: set that address as the public Nextcloud URL on the Bee Flow setup page.`;
        }
        return `Your Bee Flow server (${config.apiBaseUrl}) cannot reach this Nextcloud at the address the connector reports (${address}). If the server reaches this Nextcloud at another address, set that address as the public Nextcloud URL on the Bee Flow setup page. If the address is on a private network, set NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 in the environment of the Bee Flow server and restart it. The server must also be able to resolve the name and trust the certificate of this Nextcloud.`;
    },
    // The connector itself could not read this Nextcloud (the step before
    // anything is sent to the Bee Flow server).
    nc_cert_untrusted: () =>
        `The connector does not trust the certificate of this Nextcloud (${config.nextcloudUrl}), so it cannot read what it needs to connect. Nothing was sent to the Bee Flow server. For a certificate from your own certificate authority, put that authority's certificate (PEM text) in the install-time value BEEFLOW_NC_CA_CERT and check that it is the authority that issued this certificate. For a self-signed certificate, leave BEEFLOW_NC_TLS_PIN at auto: the connector then keeps to the certificate it saw first.`,
    nc_unreachable: () =>
        `The connector cannot read this Nextcloud at ${config.nextcloudUrl}, so it has nothing to connect with yet. Nothing was sent to the Bee Flow server. Check that this address answers from inside the connector container; the connector log names the cause.`,
    admin_lookup_failed:
        'No admin user found in this Nextcloud. Add one with `occ user:add --group admin <uid>` then redeploy the connector.',
    admin_email_missing:
        'Your Nextcloud admin user has no email address. Set an email on the admin account (Settings → Users) and redeploy the connector, or bind this Nextcloud to an existing Bee Flow organisation with a pairing code.',
    saas_auth_rejected:
        'Your Bee Flow server rejected the connector\'s credentials. Check that this Nextcloud has not been disabled in your Bee Flow organisation.',
    tenant_already_provisioned:
        'Your Bee Flow server answered that this Nextcloud, or its administrator, is already known there. To connect this Nextcloud to the existing organisation, ask a Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page.',
    pairing_required: () =>
        `${serverLabel()} does not create an organisation by itself. Ask your Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page.`,
    pairing_code_invalid: () =>
        `${serverLabel()} does not accept this pairing code: it is mistyped, expired or already used. Ask your Bee Flow organisation admin to generate a new one (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page. Nothing has to be installed again.`,
    version_mismatch:
        'The Bee Flow server at this address has no endpoint for this connector. Update the Bee Flow server and the connector to their latest release, and check that the address is the one of the server, not of the web app.',
    appstore_signature_invalid:
        'The downloaded connector tarball failed signature verification. Uninstall and reinstall from the App Store.',
    unknown:
        'Bootstrap failed. Check `docker logs nc_app_bee_flow --tail 200` for details.',
};
/**
 * @param {string} category
 * @returns {string}
 */
function remediationFor(category) {
    const text = REMEDIATION[category] || REMEDIATION.unknown;
    return typeof text === 'function' ? text() : text;
}

// The failures the Bee Flow server answers with a text of its own, where the
// connector's text is the one to show: it names the server this install is on
// and the setup page.
const OWN_REMEDIATION_WINS = new Set(['nc_not_publicly_reachable', 'pairing_required', 'pairing_code_invalid']);

/**
 * The remediation of one failure, as stored and as answered to the
 * administrator who started it: the text the Bee Flow server sent along,
 * except for the categories above; without one, the connector's text for a
 * failure on its own side of the connection.
 * @param {string} category
 * @param {string | null | undefined} fromServer
 * @param {string | undefined} phase
 * @returns {string | null}
 */
function remediationOf(category, fromServer, phase) {
    if (OWN_REMEDIATION_WINS.has(category)) return remediationFor(category);
    if (fromServer) return fromServer;
    return phase === 'capabilities' ? remediationFor(category) : null;
}

/**
 * The remediation of the failure on record, as diagnostics and the heartbeat
 * show it: the same text the administrator who started the attempt got and the
 * file on the volume holds. A text that names the server is read now, so it
 * names the server in use; a failure without a stored text gets the
 * connector's text for its category.
 * @param {{ category: string, remediation?: string | null }} state
 * @returns {string}
 */
function remediationShown(state) {
    if (OWN_REMEDIATION_WINS.has(state.category)) return remediationFor(state.category);
    return state.remediation || remediationFor(state.category);
}

/**
 * What lies under a "fetch failed": the code and message of its cause
 * (a refused certificate, a refused connection, a name that does not resolve).
 * @param {unknown} err
 * @returns {string}
 */
function causeDetail(err) {
    const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : null;
    if (typeof cause !== 'object' || cause === null) return '';
    const code = errCode(cause);
    const message = errMessage(cause);
    return [code, message && message !== code ? message : ''].filter(Boolean).join(': ');
}

/** @type {BootstrapErrorState | null} */
let lastErrorState = null;
/**
 * The last switch to another server that did not happen: which server, and
 * why. In memory only; the next change of server starts with none.
 * @typedef {{ apiBaseUrl: string, category: string, error: string, remediation: string, at: string }} RejectedSwitch
 * @type {RejectedSwitch | null}
 */
let _rejectedSwitch = null;
/** @returns {RejectedSwitch | null} */
function getRejectedSwitch() { return _rejectedSwitch; }
/**
 * The switch to that server is no longer asked for: what is kept about it goes.
 * A record about another server stays.
 * @param {string} apiBaseUrl
 */
function withdrawRejectedSwitch(apiBaseUrl) {
    const named = String(apiBaseUrl || '').replace(/\/+$/, '');
    if (_rejectedSwitch && _rejectedSwitch.apiBaseUrl === named) _rejectedSwitch = null;
}
/**
 * @returns {BootstrapErrorState | null}
 */
function getLastErrorState() { return lastErrorState; }
/**
 * Is a server chosen while connecting to it failed, and is there no key? That
 * is the state after a first choice whose connect was refused or got no
 * answer. Not while a code is awaited (the embedded app has its own screen for
 * that) and not during a re-bootstrap of an install that holds a binding.
 * @returns {boolean}
 */
function connectFailed() {
    if (!config.apiBaseUrl || config.tenantKey || _rebindKey) return false;
    if (pendingState && (pendingState.status === 'awaiting_email_verification' || pendingState.status === 'pending')) return false;
    return lastErrorState?.status === 'failed';
}
/**
 * @returns {Promise<BootstrapErrorState | null>}
 */
async function readErrorFile() {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.category) return parsed;
    } catch { /* missing */ }
    return null;
}
/**
 * @param {BootstrapErrorState} data
 */
function writeErrorFile(data) {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    return inErrorFileOrder(async () => {
        try {
            await fs.mkdir(config.persistentStorage, { recursive: true });
            await writeFileAtomic(p, JSON.stringify(data, null, 2));
        } catch (e) {
            log.warn(`[Bootstrap] Could not persist error state to ${p}: ${errMessage(e)}`);
        }
    });
}
// Writes and removals of the record happen in the order they were asked for:
// some are not awaited by their caller, and a removal must not be overtaken by
// the write before it.
/** @type {Promise<void>} */
let _errorFileQueue = Promise.resolve();
/**
 * @param {() => Promise<void>} step  never rejects
 * @returns {Promise<void>}
 */
function inErrorFileOrder(step) {
    _errorFileQueue = _errorFileQueue.then(step);
    return _errorFileQueue;
}
/**
 * Put the failure record back to an earlier one (or to none), in memory and
 * on the volume. A retry that is still scheduled keeps its time.
 * @param {BootstrapErrorState | null} earlier
 */
async function restoreErrorState(earlier) {
    if (!earlier) {
        await clearErrorFile();
        return;
    }
    const nextRetryAt = _bootstrapRetryTimer ? (lastErrorState?.nextRetryAt ?? null) : null;
    lastErrorState = { ...earlier, nextRetryAt };
    await writeErrorFile(lastErrorState);
}
async function clearErrorFile() {
    const p = path.join(config.persistentStorage, ERROR_FILE);
    await inErrorFileOrder(async () => {
        try { await fs.unlink(p); } catch (_) { /* already gone */ }
    });
    lastErrorState = null;
}

// SaaS-side structured `code` values that map directly to a connector
// category — preferred over string-matching on the error message because
// it's stable across SaaS releases.
/** @type {Record<string, string>} */
const SAAS_CODE_TO_CATEGORY = {
    nc_capabilities_unreachable: 'nc_not_publicly_reachable',
    // The server refuses the address the connector reports for this Nextcloud
    // (a private or loopback address, for one): the same situation, and the
    // server's own remediation text names the setting.
    invalid_callback_url: 'nc_not_publicly_reachable',
    nc_capabilities_mismatch: 'nc_capabilities_mismatch',
    missing_headers: 'connector_outdated',
    invalid_admin_email: 'admin_email_invalid',
    admin_email_conflict: 'admin_email_conflict',
    too_many_pending_bindings: 'too_many_pending',
    pending_admin_approval: 'awaiting_admin_approval',
    org_create_failed: 'saas_transient',
    pairing_required: 'pairing_required',
    // The pairing code that came along is not one the server accepts.
    pairing_code_invalid: 'pairing_code_invalid',
    // An existing binding the connector can no longer prove: a pairing code rebinds it.
    NC_REBIND_PROOF_REQUIRED: 'pairing_required',
};

// The Bee Flow server's certificate does not verify (see serverTls.js).
const CERT_UNTRUSTED = 'saas_cert_untrusted';

/**
 * The code of a request to the Bee Flow server that got no answer: a refused
 * certificate has its own, everything else is "unreachable".
 * @param {unknown} err
 * @returns {string}
 */
function noAnswerCode(err) {
    return isCertificateError(err) ? CERT_UNTRUSTED : 'saas_unreachable';
}

// Categorise a thrown error into one of the well-known buckets that the
// SPA's error overlay knows how to render. Prefers a structured `code`
// set on the error (from a parsed SaaS response) and falls back to
// message inspection. Anything we don't recognise falls through as
// `unknown` — still surfaced, just without specific remediation copy.
/**
 * @param {unknown} err
 * @param {string} [phase]
 * @returns {string}
 */
function categoriseError(err, phase) {
    const code = errCode(err);
    if (code && SAAS_CODE_TO_CATEGORY[code]) return SAAS_CODE_TO_CATEGORY[code];
    // Connector-local codes (set before the SaaS POST) take precedence over the
    // phase-based buckets below — otherwise phase==='admin' would mislabel a
    // missing-email failure as a generic admin_lookup_failed.
    if (code === 'admin_email_missing') return 'admin_email_missing';
    // A server that answers, but has no bootstrap endpoint: it predates this
    // connector (or is not the server at all).
    if (phase === 'saas_post' && err instanceof Error && err.status === 404) return 'version_mismatch';
    const msg = errText(err);
    // The connector's own read of this Nextcloud failed: nothing has been sent
    // to the Bee Flow server yet, and the cause is on this side.
    if (phase === 'capabilities') return isCertificateError(err) ? 'nc_cert_untrusted' : 'nc_unreachable';
    // The Bee Flow server says it could not read this Nextcloud.
    if (/NC capabilities/i.test(msg)) return 'nc_not_publicly_reachable';
    if (phase === 'admin' || /admin/i.test(msg) && /No NC users|admin from user list/i.test(msg)) return 'admin_lookup_failed';
    // The Bee Flow server answered the TLS handshake with a certificate that
    // does not verify (fetch reports it as the cause of "fetch failed").
    if (isCertificateError(err)) return CERT_UNTRUSTED;
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
/**
 * @param {unknown} err
 * @param {BootstrapPhase} [phase]
 * @param {{ remediation?: string }} [opts]
 * @returns {Promise<BootstrapErrorState>}
 */
async function recordBootstrapError(err, phase, opts = {}) {
    const category = categoriseError(err, phase);
    const now = new Date().toISOString();
    const cause = causeDetail(err);
    /** @type {BootstrapErrorState} */
    const state = {
        status: 'failed',
        category,
        phase: phase || 'unknown',
        error: `${errText(err) || 'unknown'}${cause ? ` (${cause})` : ''}`,
        remediation: remediationOf(category, opts.remediation || (err instanceof Error ? err.remediation : undefined), phase),
        lastAttemptAt: now,
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    lastErrorState = state;
    await writeErrorFile(state);
    log.warn(`[Bootstrap] ${category} (${phase || '-'}): ${state.error}`);
    return state;
}

// Arm the Task Processing idle poller once the tenant key exists.
//
// taskProcessing.startPolling() early-returns while config.tenantKey is null,
// and its only other caller runs at boot (server.js) BEFORE bootstrap — so on
// an auto-bootstrap install the poll backstop never starts and queued
// Assistant/AI tasks are never drained (the AppAPI trigger alone is not enough:
// Nextcloud suppresses it while a same-type task is already running). Calling it
// here, at every point the key becomes set, closes that gap. It is idempotent
// (guarded by its own _pollTimer + tenantKey) and unref'd, and the require is
// lazy to avoid a bootstrap↔taskProcessing circular import at module load.
function armTaskPolling() {
    try {
        require('./taskProcessing').startPolling();
    } catch (err) {
        log.warn(`[Bootstrap] could not arm the task-processing poller: ${errMessage(err)}`);
    }
}

// Everything that needs a tenant key and was skipped without one (Assistant
// providers, Files actions, webhook rows whose secret derives from the key)
// subscribes here. Fired every time a key becomes active: at boot from the
// cache, after a provision, an email verification, a pairing code, a server
// switch or a rotation. Listeners run in the background and must be
// idempotent; heartbeat.js coalesces its registrations.
/** @type {Array<() => unknown>} */
const _tenantKeyListeners = [];

/** @param {() => unknown} listener */
function onTenantKeyReady(listener) {
    _tenantKeyListeners.push(listener);
}

function tenantKeyReady() {
    stopBootstrapRetry();
    armTaskPolling();
    for (const listener of _tenantKeyListeners) {
        try {
            Promise.resolve(listener()).catch(err => log.warn(`[Bootstrap] tenant-key listener failed: ${errMessage(err)}`));
        } catch (err) {
            log.warn(`[Bootstrap] tenant-key listener failed: ${errMessage(err)}`);
        }
    }
}

// What waits for a Bee Flow server rather than for a key (the Talk bot)
// subscribes here. Fired when a server becomes known at runtime: an
// administrator chose one where there was none.
/** @type {Array<() => unknown>} */
const _serverChosenListeners = [];

/** @param {() => unknown} listener */
function onServerChosen(listener) {
    _serverChosenListeners.push(listener);
}

function serverChosen() {
    for (const listener of _serverChosenListeners) {
        try {
            Promise.resolve(listener()).catch(err => log.warn(`[Bootstrap] server-chosen listener failed: ${errMessage(err)}`));
        } catch (err) {
            log.warn(`[Bootstrap] server-chosen listener failed: ${errMessage(err)}`);
        }
    }
}

/** @type {NodeJS.Timeout | null} */
let _bootstrapRetryTimer = null;
let _bootstrapRetryAttempts = 0;

function stopBootstrapRetry() {
    if (_bootstrapRetryTimer) clearTimeout(_bootstrapRetryTimer);
    _bootstrapRetryTimer = null;
    _bootstrapRetryAttempts = 0;
}

// A rejection that will not change by asking again (bad pairing code,
// provisioning closed, signature refused) waits for the admin instead.
/** @param {unknown} err */
function isRetryableBootstrapError(err) {
    const status = err instanceof Error ? err.status : undefined;
    return !status || status >= 500 || status === 408 || status === 429;
}

/** @param {unknown} err */
function scheduleBootstrapRetry(err) {
    // A re-bootstrap of an install that holds a binding goes back to that
    // binding when it fails (invalidateAndRebootstrap): there is nothing to
    // try again. The retry is for an install without a key.
    if (_rebindKey) {
        if (lastErrorState) {
            lastErrorState = { ...lastErrorState, nextRetryAt: null };
            writeErrorFile(lastErrorState).catch(() => {});
        }
        return;
    }
    if (_bootstrapRetryTimer || config.tenantKey || !config.isAutoTenantKey) return;
    if (!(BOOTSTRAP_RETRY_MS > 0) || !isRetryableBootstrapError(err)) {
        if (lastErrorState) {
            lastErrorState = { ...lastErrorState, nextRetryAt: null };
            writeErrorFile(lastErrorState).catch(() => {});
        }
        return;
    }
    const delay = Math.min(BOOTSTRAP_RETRY_MS * 2 ** _bootstrapRetryAttempts, BOOTSTRAP_RETRY_MAX_MS);
    _bootstrapRetryAttempts += 1;
    if (lastErrorState) {
        lastErrorState = { ...lastErrorState, nextRetryAt: new Date(Date.now() + delay).toISOString() };
        writeErrorFile(lastErrorState).catch(() => {});
    }
    _bootstrapRetryTimer = setTimeout(() => {
        _bootstrapRetryTimer = null;
        if (config.tenantKey || _rebindKey || pendingState?.status === 'awaiting_email_verification') return;
        log.info(`[Bootstrap] retrying the bootstrap (attempt ${_bootstrapRetryAttempts + 1})`);
        bootstrapIfNeeded().catch(e => log.warn(`[Bootstrap] retry failed: ${errMessage(e)}`));
    }, delay);
    _bootstrapRetryTimer.unref?.();
}

/**
 * @param {SaasBootstrapResponse} json
 * @param {string | undefined} ncInstanceId
 * @param {string} [apiBaseUrl]  the server that issued the key, when it is not (any longer) config.apiBaseUrl
 */
async function applyTenantKeyResponse(json, ncInstanceId, apiBaseUrl) {
    const tenantKey = json.tenantKey;
    if (!tenantKey) throw new Error('Bootstrap response missing tenantKey');
    // No server, no key in memory.
    if (!apiBaseUrl && !config.apiBaseUrl) throw notChosenError();
    // A key is only valid on the server that issued it: a verification
    // finished after a server switch binds the connector to that server.
    if (apiBaseUrl && apiBaseUrl !== config.apiBaseUrl && !config.apiBaseUrlLocked) {
        log.info(`[Bootstrap] Switching to ${apiBaseUrl}, the server that issued this key`);
        config.apiBaseUrl = apiBaseUrl;
    }
    config.tenantKey = tenantKey;
    config.organizationId = json.organizationId ?? null;
    config.organizationName = json.organizationName ?? null;
    config.ncInstanceId = ncInstanceId ?? null;
    await writeCache({
        tenantKey,
        organizationId: json.organizationId,
        organizationName: json.organizationName,
        ncInstanceId,
        ncVersion: json.ncVersion,
        // Pin: remember which Bee Flow server provisioned this org so a later
        // change to the default/picker URL can't silently repoint the connector
        // and mint a second org elsewhere. Only an explicit reset
        // (invalidateAndRebootstrap) drops this by deleting the cache.
        boundApiBaseUrl: config.apiBaseUrl ?? undefined,
        provisionedAt: new Date().toISOString(),
    });
    await deletePendingFile();
    pendingState = null;
    tenantKeyReady();
}

// Poll the SaaS for an approved binding. Spawned in the background when the
// bootstrap returns 202; returns once the binding is approved (and the
// tenant key is cached) or denied/expired (gives up). The connector keeps
// running with no tenant key in the meantime — heartbeat surfaces this.
/**
 * @param {PendingBinding} pending
 */
async function pollPendingBinding(pending) {
    const stopAt = new Date(pending.expiresAt ?? NaN).getTime() + POLL_GRACE_AFTER_EXPIRY_MS;
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
            res = await fetch(`${pending.apiBaseUrl || config.apiBaseUrl}${pending.pollUrl}`, {
                signal: AbortSignal.timeout(10_000),
            });
        } catch (e) {
            log.warn(`[Bootstrap] Poll failed (will retry): ${errMessage(e)}`);
            continue;
        }
        if (res.status === 202) continue;
        if (res.status === 410) {
            const body = /** @type {SaasBootstrapResponse} */ (await res.json().catch(() => ({})));
            log.warn(`[Bootstrap] Pending binding ${body.status || 'denied/expired'} — abandoning poll`);
            pendingState = { ...pendingState, status: body.status || 'denied' };
            await deletePendingFile();
            return;
        }
        if (res.ok) {
            const json = /** @type {SaasBootstrapResponse} */ (await res.json());
            if (!json.tenantKey) {
                log.warn('[Bootstrap] Pending poll returned 200 without tenantKey — retrying');
                continue;
            }
            await applyTenantKeyResponse(json, pending.ncInstanceId, pending.apiBaseUrl);
            log.info(`[Bootstrap] Bound to existing org ${json.organizationId} (${json.organizationName})`);
            return;
        }
        // 4xx/5xx other than 202/410 — keep trying with backoff, capped.
        log.warn(`[Bootstrap] Poll HTTP ${res.status}, retrying`);
    }
    log.warn('[Bootstrap] Pending binding poll window elapsed — giving up');
    pendingState = { ...pendingState, status: 'expired' };
    await deletePendingFile();
}

// Resolve the in-flight verification pending from memory (preferred) or disk.
/**
 * @returns {Promise<PendingBinding | PendingState | null>}
 */
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
/**
 * @param {unknown} code
 * @returns {Promise<{ ok: true, organizationId?: string, organizationName?: string }>}
 */
async function submitVerificationCode(code) {
    // A pending file on disk names the server that issued it; without a chosen
    // server it is not acted on.
    if (!config.apiBaseUrl) throw notChosenError();
    const pending = await currentVerificationPending();
    if (!pending || !pending.verifyUrl) {
        const e = new Error('No pending Nextcloud verification to confirm');
        e.code = 'no_pending';
        throw e;
    }
    let res;
    try {
        res = await fetch(`${pending.apiBaseUrl || config.apiBaseUrl}${pending.verifyUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(code || '').trim() }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to verify the code: ${errMessage(e)}`);
        err.code = noAnswerCode(e);
        throw err;
    }
    const json = /** @type {SaasBootstrapResponse} */ (await res.json().catch(() => ({})));
    if (res.ok && json.tenantKey) {
        await applyTenantKeyResponse(json, pending.ncInstanceId, pending.apiBaseUrl);
        await clearErrorFile();
        log.info(`[Bootstrap] Email verification succeeded — bound to org ${json.organizationId} (${json.organizationName})`);
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
/**
 * @returns {Promise<{ ok: true, maskedEmail?: string | null, expiresAt?: string, emailSent?: boolean }>}
 */
async function resendVerificationCode() {
    if (!config.apiBaseUrl) throw notChosenError();
    const pending = await currentVerificationPending();
    if (!pending || !pending.resendUrl) {
        const e = new Error('No pending Nextcloud verification to resend');
        e.code = 'no_pending';
        throw e;
    }
    let res;
    try {
        res = await fetch(`${pending.apiBaseUrl || config.apiBaseUrl}${pending.resendUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to resend the code: ${errMessage(e)}`);
        err.code = noAnswerCode(e);
        throw err;
    }
    const json = /** @type {SaasBootstrapResponse} */ (await res.json().catch(() => ({})));
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
/** @type {Promise<void> | null} */
let _bootstrapInFlight = null;
// Bumped by every explicit reset (invalidateAndRebootstrap). A provision that
// started before the reset may still be waiting on its server; when it
// answers, its result belongs to the abandoned target and is dropped instead
// of overwriting the newer binding.
let _provisionGeneration = 0;
// The tenant key a re-bootstrap (invalidateAndRebootstrap) held before it
// dropped its cache, with the server it belongs to. The server releases an
// existing binding only to a bootstrap signed with that key (X-Beeflow-Sig);
// it is used for that one server only and cleared when the re-bootstrap ends.
/** @type {{ key: string, apiBaseUrl: string } | null} */
let _rebindKey = null;

const BOOTSTRAP_PATH = '/auth/connector/bootstrap';

/** @param {string | null | undefined} url */
const sameServer = (url) => String(url || '').replace(/\/+$/, '') === String(config.apiBaseUrl || '').replace(/\/+$/, '');

/**
 * X-Beeflow-Sig for a bootstrap body, the scheme every connector-to-server
 * call uses: HMAC-SHA256 over `ts\nPOST\n<path>\n<body>` with the tenant key.
 * Null when no key for the current server is held.
 * @param {string} body
 */
function rebindSignature(body) {
    if (!_rebindKey || !sameServer(_rebindKey.apiBaseUrl)) return null;
    const ts = Math.floor(Date.now() / 1000);
    const sig = require('crypto').createHmac('sha256', _rebindKey.key)
        .update(`${ts}\nPOST\n${BOOTSTRAP_PATH}\n${body}`).digest('hex');
    return `${ts}.${sig}`;
}
/**
 * @returns {Promise<void>}
 */
function bootstrapIfNeeded() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try { return await _provisionFlow(); }
        catch (err) { scheduleBootstrapRetry(err); throw err; }
        finally { _bootstrapInFlight = null; }
    })();
    return _bootstrapInFlight;
}

let _notChosenLogged = false;

/**
 * The instance id of this Nextcloud for an install-time tenant key.
 *
 * A key the server issued comes with the id it was issued for
 * (tenant-key.json). An install-time key comes alone, and every signed call to
 * the Bee Flow server (push-trigger events, Talk messages, Assistant tasks, the
 * app menu) names the instance: the id is read from Nextcloud the way the
 * bootstrap reads it, which is the id the server knows this Nextcloud by. One
 * request to Nextcloud, none to the Bee Flow server. While Nextcloud does not
 * answer it is asked again, with the delays of the bootstrap retry.
 * @returns {Promise<boolean>} whether the id is known now
 */
async function resolveInstanceIdForEnvKey() {
    if (config.ncInstanceId) return true;
    try {
        const caps = await fetchCapabilities();
        config.ncInstanceId = caps.instanceId;
        _instanceIdRetryAttempts = 0;
        return true;
    } catch (err) {
        log.warn(`[Bootstrap] could not read this Nextcloud's instance id yet (${errMessage(err)}); `
            + 'push triggers, the Talk bot and Assistant tasks start once it is known');
        scheduleInstanceIdRetry();
        return false;
    }
}

/** @type {NodeJS.Timeout | null} */
let _instanceIdRetryTimer = null;
let _instanceIdRetryAttempts = 0;

function scheduleInstanceIdRetry() {
    if (_instanceIdRetryTimer || !(BOOTSTRAP_RETRY_MS > 0)) return;
    const delay = Math.min(BOOTSTRAP_RETRY_MS * 2 ** _instanceIdRetryAttempts, BOOTSTRAP_RETRY_MAX_MS);
    _instanceIdRetryAttempts += 1;
    _instanceIdRetryTimer = setTimeout(() => {
        _instanceIdRetryTimer = null;
        // Only for an install-time key that is still in use.
        if (config.isAutoTenantKey || !config.tenantKey || config.ncInstanceId) return;
        resolveInstanceIdForEnvKey()
            .then((known) => { if (known) tenantKeyReady(); })
            .catch(e => log.warn(`[Bootstrap] instance id retry failed: ${errMessage(e)}`));
    }, delay);
    _instanceIdRetryTimer.unref?.();
}

async function _provisionFlow() {
    const generation = _provisionGeneration;
    const superseded = () => {
        if (generation === _provisionGeneration) return false;
        log.warn('[Bootstrap] a newer setup change superseded this provision — its answer is dropped');
        return true;
    };
    // No server chosen: stop before anything is read or asked. It returns
    // rather than throws, so no retry is scheduled either; the flow runs again
    // when an administrator chooses a server.
    if (!config.apiBaseUrl) {
        if (!_notChosenLogged) {
            _notChosenLogged = true;
            log.info('[Bootstrap] No Bee Flow server chosen; waiting for an administrator');
        }
        return;
    }
    if (!config.isAutoTenantKey) {
        // An install-time key and a server that became known later (an
        // administrator chose it, or a re-bootstrap dropped the key from
        // memory): the key is taken into use as it is. No bootstrap request.
        if (!config.tenantKey && config.envTenantKey) {
            config.tenantKey = config.envTenantKey;
            await clearErrorFile();
            await resolveInstanceIdForEnvKey();
            log.info('[Bootstrap] BEEFLOW_TENANT_KEY is in use for the chosen server');
            tenantKeyReady();
            return;
        }
        // The key was in use from the start (the server is fixed at install
        // time too). What signs with the instance id starts once it is known.
        if (config.tenantKey && !config.ncInstanceId && await resolveInstanceIdForEnvKey()) {
            tenantKeyReady();
        }
        log.info('[Bootstrap] BEEFLOW_TENANT_KEY explicitly set, skipping auto-bootstrap');
        return;
    }

    const cached = await readCache();
    if (cached?.tenantKey) {
        config.tenantKey = cached.tenantKey;
        config.organizationId = cached.organizationId || null;
        config.organizationName = cached.organizationName || null;
        config.ncInstanceId = cached.ncInstanceId || null;
        // Pin to the server this org was provisioned on. A changed default (or
        // picker) URL must not silently move a bound connector to a different
        // Bee Flow server — that would mint a second org there. An explicit
        // BEEFLOW_API_BASE_URL env override (config.apiBaseUrlLocked) still wins;
        // only an explicit reset (setup picker → invalidateAndRebootstrap, which
        // deletes the cache) drops the pin.
        if (cached.boundApiBaseUrl && !config.apiBaseUrlLocked) {
            if (config.apiBaseUrl !== cached.boundApiBaseUrl) {
                log.warn(`[Bootstrap] Pinning to bound server ${cached.boundApiBaseUrl} (ignoring configured ${config.apiBaseUrl})`);
            }
            config.apiBaseUrl = cached.boundApiBaseUrl;
        } else if (!cached.boundApiBaseUrl && !config.apiBaseUrlLocked) {
            // A cache from before the pin existed: record the server this
            // binding resolved to, so it is named in the file from now on.
            await writeCache({ ...cached, boundApiBaseUrl: config.apiBaseUrl });
        }
        await clearErrorFile();
        log.info(`[Bootstrap] Loaded cached tenant key for org ${cached.organizationId}`);
        tenantKeyReady();
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
        const expiresMs = new Date(existingPending.expiresAt ?? NaN).getTime();
        const stillValid = Number.isFinite(expiresMs) && Date.now() < expiresMs + POLL_GRACE_AFTER_EXPIRY_MS;
        if (stillValid && (existingPending.kind === 'verification' || existingPending.verifyUrl)) {
            // Email-code verification waits on the admin entering the code in
            // the embedded view — restore the state so the SPA re-renders the
            // verification screen. No polling: the user action drives it.
            pendingState = { status: 'awaiting_email_verification', ...existingPending };
            log.info(`[Bootstrap] Resuming email verification ${existingPending.pendingId}`);
            return;
        }
        if (stillValid && existingPending.pollUrl) {
            log.info(`[Bootstrap] Resuming pending binding ${existingPending.pendingId} (awaiting admin approval)`);
            pollPendingBinding(existingPending).catch(e => log.warn('[Bootstrap] Pending poll crashed:', errMessage(e)));
            return;
        }
        await deletePendingFile();
    }

    log.info(`[Bootstrap] No cached tenant key; connecting to ${config.apiBaseUrl}...`);

    let caps, admins, admin;
    try {
        caps = await fetchCapabilities();
    } catch (err) {
        await recordBootstrapError(err, 'capabilities');
        throw err;
    }
    try {
        admins = await fetchAdmins();
        admin = admins[0]; // primary (stable, sorted) — pinned as org.nc_admin_uid
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
        /** @type {Record<string, string>} */
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
            log.info(`[Bootstrap] Attaching pairing code ${config.pairingCode.slice(0, 4)}*** for redemption`);
        }
        // ncAdmins carries EVERY NC admin (with email) so the SaaS can
        // provision them all as org_admins. The X-Beeflow-NC-Admin-* headers
        // above still carry the primary (admins[0]) for backward compat with
        // SaaS versions that predate ncAdmins.
        const body = JSON.stringify({ themingName: caps.themingName, version: caps.version, ncAdmins: admins });
        // A re-bootstrap of an existing binding proves it with the key it held.
        const sig = rebindSignature(body);
        if (sig) headers['X-Beeflow-Sig'] = sig;
        res = await fetch(`${config.apiBaseUrl}${BOOTSTRAP_PATH}`, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        // Network-level failure (DNS, refused, timeout). Distinct from a
        // SaaS HTTP error which is handled below.
        await recordBootstrapError(err, 'saas_post');
        throw err;
    }

    if (superseded()) return;

    if (res.status === 202) {
        const json = /** @type {SaasBootstrapResponse} */ (await res.json());
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
            /** @type {PendingBinding} */
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
                apiBaseUrl: config.apiBaseUrl,
            };
            await writePendingFile(pending);
            pendingState = { status: 'awaiting_email_verification', ...pending };
            await clearErrorFile(); // verification is a valid in-flight state
            log.info(`[Bootstrap] Awaiting email verification (pending ${json.pendingId}, code sent to ${json.maskedEmail})`);
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
            apiBaseUrl: config.apiBaseUrl,
        };
        await writePendingFile(pending);
        log.info(`[Bootstrap] Awaiting org-admin approval (pending ${json.pendingId}, expires ${json.expiresAt})`);
        await clearErrorFile(); // pending is a valid in-flight state, not a failure
        pollPendingBinding(pending).catch(e => log.warn('[Bootstrap] Pending poll crashed:', errMessage(e)));
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
        const e = new Error(`${serverLabel()} refused the connection (HTTP ${res.status}): ${msg}`);
        e.status = res.status;
        if (parsed?.code) e.code = parsed.code;
        // What the administrator who started this reads (setup.js) is what is
        // stored: the text that names the server this install is on.
        const recorded = await recordBootstrapError(e, 'saas_post', { remediation: parsed?.remediation });
        if (recorded.remediation) e.remediation = recorded.remediation;
        throw e;
    }
    const json = /** @type {SaasBootstrapResponse} */ (await res.json());
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
        log.info('[Bootstrap] Pairing code redeemed — clearing for future restarts');
        config.pairingCode = null;
    }
    log.info(`[Bootstrap] Provisioned org ${json.organizationId} (${json.organizationName}) — tenant key cached`);
}

/**
 * Drop the cached tenant key + any in-flight pending binding, clear the
 * in-memory tenant key on `config`, and run a fresh bootstrap, against
 * `apiBaseUrl` when given (a server switch from /setup or the admin settings
 * form) or the current server (clear-cache, a new public URL, a pairing code).
 *
 * Resolves `{ status: 'bound' }` with a key, or `{ status:
 * 'verification_pending' }` when the server wants the emailed code first: the
 * connector then stays on that server, keyless, and the embedded app shows the
 * code screen, exactly as on a fresh install. Verify, resend and retarget go
 * to the server that issued the pending binding.
 *
 * On failure everything rolls back (key, server URL, cache, pending state)
 * and the error is thrown. One exception: a first choice (there was no server
 * before) stays chosen. The connector is then on that server without a key,
 * with the failure recorded, exactly like an install whose first bootstrap
 * failed: heartbeat, diagnostics and the retry all work from there, and the
 * administrator can add what was missing (a pairing code, a public URL).
 * @param {{ pairingCode?: string, apiBaseUrl?: string }} [opts]
 * @returns {Promise<{ status: 'bound' | 'verification_pending' }>}
 */
async function invalidateAndRebootstrap({ pairingCode, apiBaseUrl } = {}) {
    // Without a target and without a chosen server there is nothing to
    // re-bootstrap against, and nothing on disk is touched.
    if (!apiBaseUrl && !config.apiBaseUrl) throw notChosenError();
    // Snapshot the previous working state so we can roll back if the new
    // target's bootstrap fails. Without this, a typo in the settings panel
    // (or a Cloud-mode pick from a localhost-only NC sandbox) wipes the
    // working tenant key and strands the connector with 502 "Tenant key not
    // configured" until something else fixes it.
    const prev = {
        apiBaseUrl: config.apiBaseUrl,
        tenantKey: config.tenantKey,
        organizationId: config.organizationId,
        organizationName: config.organizationName,
        ncInstanceId: config.ncInstanceId,
        /** @type {string | null} */
        cacheFile: null,
        pairingCode: config.pairingCode,
    };
    // The failure on record belongs to the server it happened on: when a
    // switch is rolled back, the record goes back to what it was and the
    // failure of the server that was not taken is kept apart (_rejectedSwitch).
    const prevError = lastErrorState;
    _rejectedSwitch = null;
    const rebindKey = prev.tenantKey && prev.apiBaseUrl ? { key: prev.tenantKey, apiBaseUrl: prev.apiBaseUrl } : null;
    _rebindKey = rebindKey;
    // An install that holds a binding has no retry waiting.
    if (rebindKey) stopBootstrapRetry();
    if (apiBaseUrl) config.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    const cachePath = path.join(config.persistentStorage, CACHE_FILE);
    try {
        prev.cacheFile = await fs.readFile(cachePath, 'utf8').catch(() => null);
    } catch (_) { /* tolerate */ }

    try {
        await fs.unlink(cachePath).catch(() => {});
        await deletePendingFile();
        pendingState = null;
        config.tenantKey = null;
        config.organizationId = null;
        config.organizationName = null;
        config.ncInstanceId = null;
        if (pairingCode) {
            config.pairingCode = pairingCode;
        }
        log.info(prev.tenantKey
            ? '[Bootstrap] Invalidated cached tenant key after setup change — re-bootstrapping'
            : '[Bootstrap] Connecting after a setup change; no tenant key is held yet');
        // Explicit admin reset must force a fresh provision, not piggy-back on an
        // in-flight one (which may be mid-bind to the old target / without the
        // pairing code).
        _bootstrapInFlight = null;
        _provisionGeneration += 1;
        await bootstrapIfNeeded();
        if (!config.tenantKey) {
            // Read through the getter: TS narrowed pendingState to null above.
            if (getPendingState()?.status === 'awaiting_email_verification') {
                log.info(`[Bootstrap] ${config.apiBaseUrl} wants the emailed code before it binds — switch pending`);
                if (apiBaseUrl) config.serverSource = 'picker';
                if (!prev.apiBaseUrl) serverChosen();
                return { status: 'verification_pending' };
            }
            // bootstrapIfNeeded swallows network errors and just logs; if we
            // got back here without a key, the new target is unreachable.
            throw new Error('bootstrap completed without producing a tenant key');
        }
        if (apiBaseUrl) config.serverSource = 'picker';
        if (!prev.apiBaseUrl) serverChosen();
        return { status: 'bound' };
    } catch (err) {
        // Before anything is awaited: the binding in use comes back below,
        // and no retry may run in between.
        if (rebindKey) stopBootstrapRetry();
        if (prev.apiBaseUrl) {
            const kept = prev.tenantKey ? 'keeping the previous tenant key' : 'there was no tenant key before and there is none now';
            log.warn(`[Bootstrap] re-bootstrap failed (${errMessage(err)}); staying on ${prev.apiBaseUrl}, ${kept}`);
            // A switch that did not happen leaves no failure of the other
            // server on the one that stays: it is kept apart, with that
            // server's name. A failed attempt on the same server (a pairing
            // code, a new public URL) is that server's newest failure and
            // stays on record.
            const attempted = config.apiBaseUrl;
            if (attempted && attempted !== prev.apiBaseUrl) {
                const failure = lastErrorState && lastErrorState !== prevError ? lastErrorState : null;
                const category = failure?.category || 'unknown';
                _rejectedSwitch = {
                    apiBaseUrl: attempted,
                    category,
                    error: failure?.error || errMessage(err),
                    // Read while the attempted server is still the configured one: the text names it.
                    remediation: remediationFor(category),
                    at: new Date().toISOString(),
                };
                config.apiBaseUrl = prev.apiBaseUrl;
                await restoreErrorState(prevError);
            }
            config.apiBaseUrl = prev.apiBaseUrl;
        } else {
            log.warn(`[Bootstrap] ${config.apiBaseUrl} is chosen, but connecting to it failed (${errMessage(err)})`);
            config.serverSource = 'picker';
            serverChosen();
        }
        config.tenantKey = prev.tenantKey;
        config.organizationId = prev.organizationId;
        config.organizationName = prev.organizationName;
        config.ncInstanceId = prev.ncInstanceId;
        config.pairingCode = prev.pairingCode;
        // A pending binding created during this attempt belongs to the target
        // we just abandoned: verify/resend would talk to it, and heartbeat
        // would report a verification the working key does not need.
        pendingState = null;
        await deletePendingFile();
        if (prev.cacheFile) {
            await writeFileAtomic(cachePath, prev.cacheFile).catch(() => {});
        }
        throw err;
    } finally {
        if (_rebindKey === rebindKey) _rebindKey = null;
    }
}

/**
 * Replace this install's tenant key with a fresh one ("Rotate tenant key").
 *
 * Asks the Bee Flow server to rotate (POST /auth/connector/rotate-key, signed
 * with the current key), then applies the new key here: cache, webhook
 * secrets and the other key-dependent registrations follow via
 * tenantKeyReady. The old key no longer verifies on the server.
 *
 * Re-bootstrapping, which this button used to do, could never rotate: the
 * server answers a known instance id with its existing key, and the admin was
 * shown that same fingerprint as "new".
 *
 * When the answer is lost after the server may have rotated (network error,
 * 5xx), the connector re-fetches its binding so it does not keep a key the
 * server no longer accepts, then reports whether the key changed.
 * @returns {Promise<{ previousFingerprint: string, fingerprint: string }>}
 */
async function rotateTenantKey() {
    if (!config.apiBaseUrl) throw notChosenError();
    const before = config.tenantKey;
    if (!before) {
        const e = new Error('There is no tenant key to rotate yet.');
        e.code = 'no_tenant_key';
        throw e;
    }
    if (!config.isAutoTenantKey) {
        const e = new Error('The tenant key is set with BEEFLOW_TENANT_KEY at install time. Rotate it in Bee Flow (Admin → Nextcloud) and register the app again with the new key.');
        e.code = 'env_tenant_key';
        throw e;
    }
    const token = jwt.sign({ purpose: 'connector:rotate-tenant-key' }, before, {
        algorithm: 'HS256', issuer: 'nextcloud-connector', audience: 'beeflow.nl', expiresIn: 60,
    });
    /** @type {Response | null} */
    let res = null;
    /** @type {unknown} */
    let netErr = null;
    try {
        res = await fetch(`${config.apiBaseUrl}/auth/connector/rotate-key`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'X-Beeflow-Source': 'nextcloud-connector' },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        netErr = e;
    }
    const json = res ? /** @type {SaasBootstrapResponse} */ (await res.json().catch(() => ({}))) : {};

    if (res?.ok && json.tenantKey) {
        if (json.tenantKey === before) {
            const e = new Error('The Bee Flow server answered with the same key; nothing was rotated.');
            e.code = 'unchanged';
            throw e;
        }
        const cached = await readCache();
        await applyTenantKeyResponse({
            tenantKey: json.tenantKey,
            organizationId: config.organizationId ?? undefined,
            organizationName: config.organizationName ?? undefined,
            ncVersion: cached?.ncVersion,
        }, config.ncInstanceId ?? undefined);
        log.info(`[Bootstrap] Tenant key rotated for org ${config.organizationId}`);
        return { previousFingerprint: keyFingerprint(before), fingerprint: keyFingerprint(json.tenantKey) };
    }

    if (res && res.status === 404) {
        const e = new Error('This Bee Flow server cannot rotate tenant keys yet. Update the Bee Flow server, then try again.');
        e.code = 'rotation_unsupported';
        throw e;
    }
    if (res && res.status < 500) {
        const e = new Error(json.error || `Key rotation refused (HTTP ${res.status})`);
        e.code = json.code || 'rotation_refused';
        e.status = res.status;
        throw e;
    }
    // Unknown outcome: the server may have rotated before the answer was lost.
    // Re-fetch the binding (a known instance gets its CURRENT key back).
    log.warn(`[Bootstrap] key rotation outcome unknown (${netErr ? errMessage(netErr) : `HTTP ${res?.status}`}); re-fetching the binding`);
    await invalidateAndRebootstrap();
    if (config.tenantKey && config.tenantKey !== before) {
        return { previousFingerprint: keyFingerprint(before), fingerprint: keyFingerprint(config.tenantKey) };
    }
    const e = new Error(`Could not rotate the tenant key: ${netErr ? errMessage(netErr) : `HTTP ${res?.status}`}. The current key is unchanged.`);
    e.code = netErr ? noAnswerCode(netErr) : 'saas_unreachable';
    throw e;
}

// First 16 hex chars of sha256(key): enough for an admin to tell two keys
// apart, never the key itself.
/** @param {string} key */
function keyFingerprint(key) {
    return require('crypto').createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

// Is this NC uid in the admin group? Gates the in-app verification request so
// only an admin can drive pairing.
/**
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
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
/**
 * @param {{ uid: string, email: string, displayName: string }} user
 * @returns {Promise<{ ok: true, maskedEmail?: string | null, expiresAt?: string, emailSent: boolean }>}
 */
async function requestVerificationCode({ uid, email, displayName }) {
    if (!config.apiBaseUrl) throw notChosenError();
    const pending = await currentVerificationPending();
    if (!pending) {
        const e = new Error('No pending Nextcloud verification');
        e.code = 'no_pending';
        throw e;
    }
    const retargetUrl = pending.retargetUrl || `/auth/connector/bootstrap/pending/${pending.pendingId}/retarget`;
    let res;
    try {
        res = await fetch(`${pending.apiBaseUrl || config.apiBaseUrl}${retargetUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, uid, displayName }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const err = new Error(`Could not reach Bee Flow to send the code: ${errMessage(e)}`);
        err.code = noAnswerCode(e);
        throw err;
    }
    const json = /** @type {SaasBootstrapResponse} */ (await res.json().catch(() => ({})));
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
    onTenantKeyReady,
    onServerChosen,
    fetchCapabilities,
    getPendingState,
    getLastErrorState,
    getRejectedSwitch,
    withdrawRejectedSwitch,
    connectFailed,
    remediationFor,
    remediationShown,
    categoriseError,
    invalidateAndRebootstrap,
    rotateTenantKey,
    submitVerificationCode,
    resendVerificationCode,
    requestVerificationCode,
    isNcAdmin,
    stableInstanceIdFallback,
    ncHostFromUrl,
    // Test hook: is a retry of the bootstrap scheduled?
    _bootstrapRetryArmedForTests: () => _bootstrapRetryTimer !== null,
};
