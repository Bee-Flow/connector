/**
 * An outbound HTTP proxy for the connection to the Bee Flow server.
 *
 * On a network where containers reach the outside only through a forward
 * proxy, two install-time values tell the connector about it:
 *
 *   HTTPS_PROXY   the proxy, as a URL (http://proxy.example:3128, with
 *                 user:password@ when the proxy asks for it)
 *   NO_PROXY      hosts that are reached directly, comma separated
 *
 *   - Only connections to a Bee Flow server over https go through the proxy
 *     (a CONNECT tunnel; the certificate of the Bee Flow server is verified
 *     end to end, with BEEFLOW_SERVER_CA_CERT when that is set).
 *   - Nextcloud is always reached directly. That is decided in code, by the
 *     origin of the request (ncTls.js for fetch, proxy.js for the proxies), and
 *     does not depend on NO_PROXY.
 *   - The proxy URL may carry credentials. They go to the proxy and nowhere
 *     else: what this file logs is the proxy's host and port.
 *
 * The values are read here and handed to the clients explicitly; nothing else
 * in the process looks at them.
 */

'use strict';

const log = require('./log');

const PROXY_ENV = 'HTTPS_PROXY';
const NO_PROXY_ENV = 'NO_PROXY';
// http.Agent's `proxyEnv` option exists from this Node release on.
const AGENT_PROXY_SINCE = [22, 21];

/**
 * The proxy URL, or null when there is none or the value cannot be used.
 * @param {unknown} raw
 * @param {{ warn?: (message: string) => void }} [opts]
 * @returns {URL | null}
 */
function parseProxyUrl(raw, opts = {}) {
    const warn = opts.warn || ((message) => log.warn(message));
    const value = String(raw || '').trim();
    if (!value) return null;
    /** @type {URL} */
    let url;
    try {
        url = new URL(value);
    } catch {
        // The value itself is not logged: it may hold a password.
        warn(`[ServerProxy] ${PROXY_ENV} is not a URL; it is ignored`);
        return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
        warn(`[ServerProxy] ${PROXY_ENV} must be an http:// or https:// URL; it is ignored`);
        return null;
    }
    return url;
}

/**
 * A proxy as it may be logged: scheme, host and port, never the credentials.
 * @param {URL} url
 * @returns {string}
 */
function describeProxy(url) {
    return `${url.protocol}//${url.host}`;
}

/** @param {string} version  process.versions.node */
function agentSupportsProxy(version) {
    const [major = 0, minor = 0] = version.split('.').map((part) => parseInt(part, 10));
    const [needMajor = 0, needMinor = 0] = AGENT_PROXY_SINCE;
    return major > needMajor || (major === needMajor && minor >= needMinor);
}

const proxyUrl = parseProxyUrl(process.env[PROXY_ENV]);
const noProxy = proxyUrl ? String(process.env[NO_PROXY_ENV] || '').trim() : '';

if (proxyUrl) {
    log.info(`[ServerProxy] connections to the Bee Flow server go through the proxy ${describeProxy(proxyUrl)}`
        + `${noProxy ? ` (direct for: ${noProxy})` : ''}; Nextcloud is always reached directly`);
    if (!agentSupportsProxy(process.versions.node)) {
        log.warn(`[ServerProxy] this Node release (${process.versions.node}) has no proxy support in its http agent; `
            + `the web app's requests reach the Bee Flow server directly. Node ${AGENT_PROXY_SINCE.join('.')} or later is needed.`);
    }
}

/** Is a proxy in use? */
function hasProxy() {
    return proxyUrl !== null;
}

/**
 * Options for undici's EnvHttpProxyAgent, which fetch uses for the Bee Flow
 * server; null without a proxy. Given explicitly, so the agent reads nothing
 * from the environment itself, and plain http is never proxied.
 * @returns {{ httpProxy: string, httpsProxy: string, noProxy: string } | null}
 */
function fetchProxyOptions() {
    return proxyUrl ? { httpProxy: '', httpsProxy: proxyUrl.href, noProxy } : null;
}

/**
 * Options to spread into the https.Agent of the proxies in proxy.js; empty
 * without a proxy.
 * @returns {{ proxyEnv?: { HTTPS_PROXY: string, NO_PROXY: string } }}
 */
function httpsAgentOptions() {
    return proxyUrl ? { proxyEnv: { HTTPS_PROXY: proxyUrl.href, NO_PROXY: noProxy } } : {};
}

module.exports = {
    PROXY_ENV,
    NO_PROXY_ENV,
    parseProxyUrl,
    describeProxy,
    agentSupportsProxy,
    hasProxy,
    fetchProxyOptions,
    httpsAgentOptions,
};
