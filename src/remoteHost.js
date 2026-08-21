/**
 * Remote-host validation — the ExApp analogue of
 * `\OCP\Security\IRemoteHostValidator`.
 *
 * Nextcloud's manual requires validating any user-supplied host before opening
 * a connection to it, to keep an app from being used to reach infrastructure
 * the caller cannot reach itself:
 *   https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/security.html
 *
 * Three admin-supplied URLs reach `fetch()` in this connector: the Bee Flow
 * server URL (setup picker and the NC admin settings panel), the "test this
 * URL" probe, and the public Nextcloud URL handed to the Bee Flow server for
 * callbacks. All three go through here.
 *
 * WHAT IS BLOCKED
 *   - any scheme other than http/https (no file:, gopher:, data:, …)
 *   - credentials embedded in the URL (`http://user:pass@host`) — those would
 *     end up in logs and in the SaaS-side callback record
 *   - link-local addresses and the cloud-metadata endpoints every hosting
 *     provider exposes there (169.254.169.254 & friends). Nothing legitimate
 *     lives at those, and they are the one target where a single unauthorised
 *     GET yields credentials.
 *
 * WHAT IS DELIBERATELY *NOT* BLOCKED: loopback and RFC1918. Self-hosting is a
 * first-class mode of this product — `http://bee-flow-server:3001` on the
 * Docker network, or a LAN address, is the documented, supported answer, and a
 * validator that rejected it would break the feature it is protecting.
 * Nextcloud makes the same trade-off configurable (`allow_local_remote_servers`);
 * here local IS the supported deployment, so the narrower block-list above is
 * the honest line.
 */

'use strict';

const dns = require('dns').promises;
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Cloud instance-metadata services. IPv4 link-local covers 169.254.169.254 and
// Alibaba's 100.100.100.200 sits outside it, so it is named explicitly.
const METADATA_HOSTS = new Set([
    '169.254.169.254',
    '100.100.100.200',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
]);

function isLinkLocalV4(ip) {
    return /^169\.254\./.test(ip);
}

function isLinkLocalV6(ip) {
    const lower = ip.toLowerCase();
    // fe80::/10 plus the IPv6 metadata endpoints AWS and friends publish.
    return /^fe[89ab][0-9a-f]:/.test(lower)
        || lower === 'fd00:ec2::254'
        || lower.startsWith('fd00:ec2:');
}

/** Is this literal IP one we refuse to connect to? */
function isBlockedAddress(ip) {
    if (!ip) return false;
    const bare = ip.replace(/^\[|\]$/g, '');
    if (METADATA_HOSTS.has(bare)) return true;
    const version = net.isIP(bare);
    if (version === 4) return isLinkLocalV4(bare);
    if (version === 6) {
        // ::ffff:169.254.169.254 — an IPv4-mapped address wearing a v6 coat.
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
        if (mapped) return isLinkLocalV4(mapped[1]) || METADATA_HOSTS.has(mapped[1]);
        return isLinkLocalV6(bare);
    }
    return false;
}

class RemoteHostError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code || 'invalid_remote_host';
    }
}

/**
 * Syntactic checks only — no DNS. Use where a synchronous answer is required
 * (config persistence, settings reconciliation).
 * @returns {URL} the parsed URL
 * @throws {RemoteHostError}
 */
function parseAllowedUrl(raw, { label = 'URL' } = {}) {
    const value = String(raw || '').trim();
    if (!value) throw new RemoteHostError(`${label} is required`, 'missing_url');
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new RemoteHostError(`${label} is not a valid URL`, 'malformed_url');
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new RemoteHostError(`${label} must start with http:// or https://`, 'bad_scheme');
    }
    if (url.username || url.password) {
        throw new RemoteHostError(`${label} must not contain a username or password`, 'credentials_in_url');
    }
    if (!url.hostname) {
        throw new RemoteHostError(`${label} has no hostname`, 'no_host');
    }
    if (isBlockedAddress(url.hostname) || METADATA_HOSTS.has(url.hostname.toLowerCase())) {
        throw new RemoteHostError(
            `${label} points at a link-local or cloud-metadata address, which this connector will not contact`,
            'blocked_host');
    }
    return url;
}

/**
 * Full check: syntax, then resolve the hostname and refuse if ANY answer is a
 * blocked address. Rebinding between this check and the connection is not
 * closed by it — Nextcloud's own validator has the same property — but a
 * hostname whose A record simply *is* the metadata endpoint is caught, which is
 * the case that actually shows up.
 *
 * @returns {Promise<URL>}
 * @throws {RemoteHostError}
 */
async function assertAllowedUrl(raw, { label = 'URL' } = {}) {
    const url = parseAllowedUrl(raw, { label });
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) return url; // literal, already checked

    let records;
    try {
        records = await dns.lookup(url.hostname, { all: true });
    } catch {
        // Unresolvable is not a security failure — it is an unreachable server,
        // and the caller reports that far more usefully than we can here.
        return url;
    }
    for (const { address } of records) {
        if (isBlockedAddress(address)) {
            throw new RemoteHostError(
                `${label} resolves to a link-local or cloud-metadata address (${address}), which this connector will not contact`,
                'blocked_host');
        }
    }
    return url;
}

module.exports = {
    assertAllowedUrl,
    parseAllowedUrl,
    isBlockedAddress,
    RemoteHostError,
    METADATA_HOSTS,
};
