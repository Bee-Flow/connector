/**
 * Connector runtime config.
 *
 * Most values come from env vars Nextcloud injects when AppAPI starts the
 * container — see ExApp lifecycle docs:
 *   https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 * BEEFLOW_TENANT_KEY and BEEFLOW_API_BASE_URL are configured by the customer
 * admin via `occ app_api:app:setenv bee_flow KEY VALUE` after install.
 */

/** @param {string} name */
function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// Auto-bootstrap mode: when BEEFLOW_TENANT_KEY is unset or set to literal
// "auto", the connector calls /auth/connector/bootstrap on first boot to
// auto-provision an org + mint a tenant key. The result is cached in
// APP_PERSISTENT_STORAGE (survives container restarts but not disk wipe).
// This is what enables one-click install from the Nextcloud App Store —
// the customer admin doesn't need to mint or paste any keys.
const rawTenantKey = process.env.BEEFLOW_TENANT_KEY || 'auto';

// Bee Flow Cloud's API. Same value as setupConfig.CLOUD_URL (that module
// needs config, so it cannot be the source here).
const CLOUD_API_BASE_URL = 'https://server.beeflow.nl';
const envApiBaseUrl = (process.env.BEEFLOW_API_BASE_URL || '').trim().replace(/\/+$/, '');
const isAutoTenantKey = (rawTenantKey === 'auto' || rawTenantKey === '');

/**
 * @typedef {object} ConnectorConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} appVersion
 * @property {string} appHost
 * @property {number} appPort
 * @property {string} persistentStorage
 * @property {string} nextcloudUrl
 * @property {string | null} nextcloudPublicUrl
 * @property {string | null} tenantKey        filled in at runtime (env, bootstrap cache or the bootstrap call)
 * @property {boolean} isAutoTenantKey
 * @property {string | null} organizationId
 * @property {string | null} organizationName
 * @property {string | null} ncInstanceId
 * @property {string} apiBaseUrl
 * @property {boolean} apiBaseUrlLocked     BEEFLOW_API_BASE_URL names a server other than Cloud: the admin's lock
 * @property {string} embedBaseUrl
 * @property {string | null} pairingCode
 * @property {number} jwtTtlSeconds
 * @property {number} sigSkewSeconds
 */

/** @type {ConnectorConfig} */
const config = {
    // ── AppAPI-injected ────────────────────────────────────────
    appId: process.env.APP_ID || 'bee_flow',
    appSecret: required('APP_SECRET'),
    appVersion: process.env.APP_VERSION || '0.0.0',
    // Always bind 0.0.0.0. AppAPI's manual-install daemon sets APP_HOST=127.0.0.1
    // assuming the container's docker-proxy maps it; HaRP's docker-install
    // daemon (harp_exapp_direct mode) needs to reach the container directly via
    // the docker network, which requires binding all interfaces. Either way,
    // the only inbound traffic is from the deploy-daemon (NC's signed-secret
    // gate enforced upstream).
    appHost: '0.0.0.0',
    appPort: parseInt(process.env.APP_PORT || '8080', 10),
    persistentStorage: process.env.APP_PERSISTENT_STORAGE || '/data',
    nextcloudUrl: required('NEXTCLOUD_URL').replace(/\/+$/, ''),
    // Public URL the SaaS uses to call NC back during bootstrap (anti-spoofing
    // capabilities check). Distinct from nextcloudUrl so that internal connector
    // → NC traffic can keep using the fast Docker-internal hostname while only
    // the bootstrap claim sent to the SaaS uses the publicly-reachable URL
    // (e.g. an ngrok / cloudflared tunnel). Falls back to nextcloudUrl when
    // unset, which is correct for production (NC is publicly addressable).
    nextcloudPublicUrl: (process.env.BEEFLOW_NC_PUBLIC_URL || '').replace(/\/+$/, '') || null,

    // ── Customer-configured / auto-provisioned ─────────────────
    // tenantKey is filled in at runtime: either from env, or from the bootstrap
    // cache file, or by calling the SaaS bootstrap endpoint. See bootstrap.js.
    tenantKey: isAutoTenantKey ? null : rawTenantKey,
    isAutoTenantKey,
    // Cache for auto-provisioned tenant key + org id. Written by bootstrap.js.
    organizationId: null,
    // Display name of that org, from the same bootstrap response; shown back to
    // the admin by /setup/clear-cache. Null until a binding is applied.
    organizationName: null,
    ncInstanceId: null,
    // Override only for staging / on-prem. Default points at the Bee Flow dev
    // environment.
    apiBaseUrl: envApiBaseUrl || CLOUD_API_BASE_URL,
    // Whether BEEFLOW_API_BASE_URL is a deliberate admin lock that the /setup
    // picker, the admin settings form and the bound-server pin must not
    // override. AppAPI exports every variable info.xml declares, with its
    // <default> when nobody typed a value (ExAppEnvVarsHelper::
    // normalizeAndValidate), so every App Store install runs with
    // BEEFLOW_API_BASE_URL=https://server.beeflow.nl. Reading "set" as "locked"
    // made the settings form a no-op and reverted a /setup switch on every
    // restart. Only a value other than the Cloud default is a lock.
    apiBaseUrlLocked: !!envApiBaseUrl && envApiBaseUrl !== CLOUD_API_BASE_URL,

    // Upstream for the embedded SPA SHELL (index.html + hashed assets). The
    // connector proxies the shell from the cloud frontend host's `/embed/`
    // build instead of baking it into the image, so a frontend deploy reaches
    // the embedded view without a connector release. Distinct from apiBaseUrl:
    // the API lives on the server pod (server.beeflow.nl) while the static
    // shell is served by the frontend front-door (beeflow.nl). Self-hosters
    // who point apiBaseUrl at their own server should also set this to their
    // frontend host. The baked /public bundle remains the offline fallback.
    embedBaseUrl: (process.env.BEEFLOW_EMBED_BASE_URL || 'https://beeflow.nl').replace(/\/+$/, ''),

    // One-shot pairing code for binding this NC to an existing Bee Flow org
    // (instead of creating a new one). Admin sets this via
    // `occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <CODE>` after
    // generating the code in the existing org's Settings → Organisation →
    // Nextcloud Sync panel. Consumed once at bootstrap; clear after.
    pairingCode: (process.env.BEEFLOW_PAIRING_CODE || '').trim().toUpperCase() || null,

    // ── Operational knobs ──────────────────────────────────────
    // JWT TTL — short on purpose. The SaaS treats every request as a new
    // bearer; we don't want a leaked token to be useful for long.
    jwtTtlSeconds: parseInt(process.env.BEEFLOW_JWT_TTL_SECONDS || '300', 10),
    // Skew tolerance for AppAPI signed-request timestamp.
    sigSkewSeconds: parseInt(process.env.BEEFLOW_SIG_SKEW_SECONDS || '300', 10),
};

module.exports = config;
