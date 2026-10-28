// @typecheck strict
/**
 * Display-name helpers for auto-provisioned Nextcloud organisations.
 *
 * Shared between the connector bootstrap (names orgs at creation time) and the
 * userStore boot backfill (renames pre-existing generic "Nextcloud" orgs).
 * Kept in its own module so userStore and connectorBootstrap can both use it
 * without a circular require.
 *
 * Also the one place the Nextcloud connector and the server agree on how a Nextcloud
 * instance is named: scripts/gen-shared-mirror.mjs copies this file byte for byte to
 * nextcloud-connector/src/shared/orgNaming.js (the connector image builds with context
 * ./nextcloud-connector and cannot see server/). Keep it free of requires.
 */

// Hostname of a Nextcloud base URL, for display. https://nc.e380.net/ → nc.e380.net.
/**
 * @param {string} ncBaseUrl
 */
function ncHostFromUrl(ncBaseUrl) {
    try {
        return new URL(ncBaseUrl).host || null;
    } catch {
        return null;
    }
}

// Stable fallback id for Nextclouds that expose neither theming.instanceid nor
// core.instanceid. The connector sends it as X-Beeflow-NC-Instance-Id and
// auth/connector/ncVerify.js re-derives it, so both sides call this very function
// (the connector through the generated copy). Keyed on the NC host (not the NC
// version) so it doesn't drift across upgrades and silently re-provision a
// duplicate org.
/**
 * @param {string} ncBaseUrl
 * @param {string | null | undefined} themingName
 */
function stableInstanceIdFallback(ncBaseUrl, themingName) {
    const host = ncHostFromUrl(ncBaseUrl);
    if (host) return `nc-host:${host}`;
    return `nc:${themingName || 'nextcloud'}`;
}

// Build a self-describing org name for an auto-provisioned Nextcloud org.
// Qualifies the instance's theming name with its host so the admin list can
// tell otherwise-identical "Nextcloud" orgs apart, e.g. "Nextcloud (nc.e380.net)".
// Skips the suffix when the name already carries the host (custom-themed instances).
/**
 * @param {string} themingName
 * @param {string} ncBaseUrl
 */
function buildAutoOrgName(themingName, ncBaseUrl) {
    const base = (themingName || 'Nextcloud').trim() || 'Nextcloud';
    const host = ncHostFromUrl(ncBaseUrl);
    if (!host || base.toLowerCase().includes(host.toLowerCase())) return base;
    return `${base} (${host})`;
}

module.exports = { ncHostFromUrl, stableInstanceIdFallback, buildAutoOrgName };
