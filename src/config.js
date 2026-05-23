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
const isAutoTenantKey = (rawTenantKey === 'auto' || rawTenantKey === '');

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
    ncInstanceId: null,
    // Override only for staging / on-prem. Production default points at our
    // public API.
    apiBaseUrl: (process.env.BEEFLOW_API_BASE_URL || 'https://server.beeflow.nl').replace(/\/+$/, ''),

    // ── Operational knobs ──────────────────────────────────────
    // JWT TTL — short on purpose. The SaaS treats every request as a new
    // bearer; we don't want a leaked token to be useful for long.
    jwtTtlSeconds: parseInt(process.env.BEEFLOW_JWT_TTL_SECONDS || '300', 10),
    // Skew tolerance for AppAPI signed-request timestamp.
    sigSkewSeconds: parseInt(process.env.BEEFLOW_SIG_SKEW_SECONDS || '300', 10),
};

module.exports = config;
