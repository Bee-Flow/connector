/**
 * Connector runtime config.
 *
 * Most values come from env vars Nextcloud injects when AppAPI starts the
 * container — see ExApp lifecycle docs:
 *   https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 * BEEFLOW_TENANT_KEY and BEEFLOW_API_BASE_URL are optional install-time values
 * (`occ app_api:app:register bee_flow <daemon> --env NAME=VALUE`, or the
 * advanced deploy options in the Nextcloud UI). Without them an administrator
 * chooses the Bee Flow server after installing; see serverChoice.js.
 *
 * A value given at install time is fixed: AppAPI replays it on every update
 * and has no command to change it. Changing one means registering the app
 * again (the data volume is kept unless `--rm-data` is passed). AppAPI passes
 * only the variables info.xml declares.
 */

const { envLock } = require('./serverChoice');
const { parseAllowedUrl } = require('./remoteHost');
const { intFromEnv } = require('./envValues');
const log = require('./log');

/** @param {string} name */
function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

/**
 * An install-time value as a log line shows it: without the user and password
 * a URL may carry, and no longer than a line can hold.
 * @param {unknown} raw
 * @returns {string}
 */
function shownValue(raw) {
    const value = String(raw || '').trim().replace(/\/\/[^/@\s]*@/, '//');
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

/**
 * BEEFLOW_EMBED_BASE_URL as a shell host: the URL without a trailing slash, or
 * '' when it is blank or not a URL this connector fetches from.
 * @param {unknown} raw
 * @returns {string}
 */
function usableEmbedBaseUrl(raw) {
    const value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        parseAllowedUrl(value, { label: 'BEEFLOW_EMBED_BASE_URL' });
    } catch (err) {
        log.warn(`[Config] ignoring BEEFLOW_EMBED_BASE_URL (${shownValue(value)}): ${err instanceof Error ? err.message : String(err)}`);
        return '';
    }
    return value;
}

/**
 * BEEFLOW_NC_PUBLIC_URL as the address the Bee Flow server calls this
 * Nextcloud back on: the URL without a trailing slash, or null when it is
 * blank or not an http(s) URL. A value that is not a URL fixes nothing: it is
 * logged and ignored, and the address entered on the setup page (or
 * NEXTCLOUD_URL) is used.
 * @param {unknown} raw
 * @returns {string | null}
 */
function usablePublicNcUrl(raw) {
    const value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('it must start with http:// or https://');
    } catch (err) {
        const why = err instanceof Error && /must start/.test(err.message) ? err.message : 'it is not a URL';
        log.warn(`[Config] ignoring BEEFLOW_NC_PUBLIC_URL (${shownValue(value)}): ${why}. The public Nextcloud URL of the setup page, or NEXTCLOUD_URL, is used.`);
        return null;
    }
    return value;
}

// Auto-bootstrap mode: when BEEFLOW_TENANT_KEY is unset or set to literal
// "auto", the connector calls /auth/connector/bootstrap on the server an
// administrator chose, to provision an org + mint a tenant key. The result is
// cached in APP_PERSISTENT_STORAGE (survives container restarts but not disk
// wipe), so the admin doesn't need to mint or paste any keys. Without a chosen
// server there is no bootstrap.
const rawTenantKey = process.env.BEEFLOW_TENANT_KEY || 'auto';

// Rule 1 of serverChoice.js: BEEFLOW_API_BASE_URL fixes the server when it is
// the word `cloud` or the URL of a server. The literal Cloud URL is not a
// lock and by itself not a choice.
const serverLock = envLock(process.env.BEEFLOW_API_BASE_URL);
if (serverLock.invalid) {
    log.warn(`[Config] ignoring BEEFLOW_API_BASE_URL (${shownValue(process.env.BEEFLOW_API_BASE_URL)}): ${serverLock.invalid}`);
}
// Bee Flow Cloud's frontend, where the embedded SPA shell comes from while the
// connector talks to Cloud. Same value as setupConfig.CLOUD_EMBED_URL. That
// same value in BEEFLOW_EMBED_BASE_URL is no lock.
const CLOUD_EMBED_BASE_URL = 'https://beeflow.nl';
// A value that is not the URL of a host (a stray word, a value AppAPI filled in
// by itself) fixes nothing: it is ignored, exactly like an unusable
// BEEFLOW_API_BASE_URL, and the shell host follows the server choice.
const envEmbedBaseUrl = usableEmbedBaseUrl(process.env.BEEFLOW_EMBED_BASE_URL);
const isAutoTenantKey = (rawTenantKey === 'auto' || rawTenantKey === '');
const envPublicNcUrl = usablePublicNcUrl(process.env.BEEFLOW_NC_PUBLIC_URL);

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
 * @property {boolean} nextcloudPublicUrlLocked  BEEFLOW_NC_PUBLIC_URL holds a URL: fixed at install time, the setup page does not change it
 * @property {string | null} tenantKey        filled in at runtime (env, bootstrap cache or the bootstrap call); always null while no server is chosen
 * @property {string | null} envTenantKey     an explicit BEEFLOW_TENANT_KEY (null in auto mode); it becomes tenantKey once a server is known
 * @property {boolean} isAutoTenantKey
 * @property {string | null} organizationId
 * @property {string | null} organizationName
 * @property {string | null} ncInstanceId
 * @property {string | null} apiBaseUrl      the chosen Bee Flow server; null until an administrator chooses one
 * @property {import('./serverChoice').ServerSource} serverSource  where apiBaseUrl came from at boot (serverChoice.js)
 * @property {boolean} apiBaseUrlLocked     BEEFLOW_API_BASE_URL fixes the server (the word `cloud` or a server URL): the admin's lock
 * @property {string} embedBaseUrl
 * @property {boolean} embedBaseUrlLocked   BEEFLOW_EMBED_BASE_URL names a host other than Cloud's frontend: the admin's lock
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
    nextcloudPublicUrl: envPublicNcUrl,
    nextcloudPublicUrlLocked: !!envPublicNcUrl,

    // ── Customer-configured / auto-provisioned ─────────────────
    // tenantKey is filled in at runtime: either from env, or from the bootstrap
    // cache file, or by calling the bootstrap endpoint of the chosen server.
    // See bootstrap.js. No server means no key in memory: an explicit
    // BEEFLOW_TENANT_KEY is applied here only when the env also fixes the
    // server, and otherwise by serverChoice.applyAtBoot once a server is known.
    tenantKey: (!isAutoTenantKey && serverLock.url) ? rawTenantKey : null,
    envTenantKey: isAutoTenantKey ? null : rawTenantKey,
    isAutoTenantKey,
    // Cache for auto-provisioned tenant key + org id. Written by bootstrap.js.
    organizationId: null,
    // Display name of that org, from the same bootstrap response; shown back to
    // the admin by /setup/clear-cache. Null until a binding is applied.
    organizationName: null,
    ncInstanceId: null,
    // The Bee Flow server. Null until one is known: at load only the env lock
    // counts; serverChoice.applyAtBoot (server.js) then resolves what the
    // install already holds (an existing binding, a saved choice), and the
    // setup page or the settings form set it when an administrator chooses.
    // Never an empty string or a placeholder.
    apiBaseUrl: serverLock.url,
    serverSource: serverLock.url ? 'env-lock' : 'none',
    // Whether BEEFLOW_API_BASE_URL is a deliberate admin lock that the /setup
    // picker, the admin settings form and the bound-server pin must not
    // override: the word `cloud`, or the URL of a server. AppAPI replays the
    // value it stored at install time on every update, so the literal Cloud
    // URL can be present without anybody having typed it; that value is not a
    // lock.
    apiBaseUrlLocked: !!serverLock.url,

    // Upstream for the embedded SPA SHELL (index.html + hashed assets). The
    // connector proxies the shell from a frontend host's `/embed/` build
    // instead of baking it into the image, so a frontend deploy reaches the
    // embedded view without a connector release. Distinct from apiBaseUrl:
    // the API lives on the server (server.beeflow.nl) while the static shell
    // is served by the frontend (beeflow.nl). This is only the Cloud default
    // or the admin's env lock: which host a request really goes to follows
    // the live server choice, see embedTarget.js (#401). The baked /public
    // bundle remains the fallback.
    embedBaseUrl: envEmbedBaseUrl || CLOUD_EMBED_BASE_URL,
    embedBaseUrlLocked: !!envEmbedBaseUrl && envEmbedBaseUrl !== CLOUD_EMBED_BASE_URL,

    // One-shot pairing code for binding this NC to an existing Bee Flow org
    // (instead of creating a new one). An install-time value, or entered on
    // the setup page after generating the code in the existing org's
    // Settings → Organisation → Nextcloud Sync panel. Consumed once at
    // bootstrap; clear after.
    pairingCode: (process.env.BEEFLOW_PAIRING_CODE || '').trim().toUpperCase() || null,

    // ── Operational knobs ──────────────────────────────────────
    // JWT TTL — short on purpose. The SaaS treats every request as a new
    // bearer; we don't want a leaked token to be useful for long.
    // Not an install-time option in info.xml; a value set on the container by
    // hand is kept between 30 seconds and 15 minutes.
    jwtTtlSeconds: intFromEnv('BEEFLOW_JWT_TTL_SECONDS', { fallback: 300, min: 30, max: 900 }),
    // How far the timestamp of a signed request may differ from this host's
    // clock. An install-time option (info.xml); blank or unusable means 300,
    // and a value is kept between 30 seconds and 15 minutes.
    sigSkewSeconds: intFromEnv('BEEFLOW_SIG_SKEW_SECONDS', { fallback: 300, min: 30, max: 900 }),
};

module.exports = config;
