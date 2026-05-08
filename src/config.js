/**
 * Connector runtime config.
 *
 * Most values come from env vars Nextcloud injects when AppAPI starts the
 * container — see ExApp lifecycle docs:
 *   https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 * BEEFLOW_TENANT_KEY and BEEFLOW_API_BASE_URL are configured by the customer
 * admin via `occ app_api:app:setenv bee_flow_ai KEY VALUE` after install.
 */

function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

const config = {
    // ── AppAPI-injected ────────────────────────────────────────
    appId: process.env.APP_ID || 'bee_flow_ai',
    appSecret: required('APP_SECRET'),
    appVersion: process.env.APP_VERSION || '0.0.0',
    appHost: process.env.APP_HOST || '0.0.0.0',
    appPort: parseInt(process.env.APP_PORT || '8080', 10),
    persistentStorage: process.env.APP_PERSISTENT_STORAGE || '/data',
    nextcloudUrl: required('NEXTCLOUD_URL').replace(/\/+$/, ''),

    // ── Customer-configured (via occ app_api:app:setenv) ───────
    // Issued by Bee Flow per tenant. Used to sign JWTs the SaaS validates
    // against the matching tenant on its side.
    tenantKey: required('BEEFLOW_TENANT_KEY'),
    // Override only for staging / on-prem. Production default points at our
    // public API.
    apiBaseUrl: (process.env.BEEFLOW_API_BASE_URL || 'https://api.beeflow.ai').replace(/\/+$/, ''),

    // ── Operational knobs ──────────────────────────────────────
    // JWT TTL — short on purpose. The SaaS treats every request as a new
    // bearer; we don't want a leaked token to be useful for long.
    jwtTtlSeconds: parseInt(process.env.BEEFLOW_JWT_TTL_SECONDS || '300', 10),
    // Skew tolerance for AppAPI signed-request timestamp.
    sigSkewSeconds: parseInt(process.env.BEEFLOW_SIG_SKEW_SECONDS || '300', 10),
};

module.exports = config;
