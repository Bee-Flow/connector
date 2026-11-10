/**
 * Is there a Bee Flow server at this address?
 *
 * One GET of `<url>/api/health`, used by the setup page ("Test connection" and
 * the first choice of a server) and by the settings form. The request carries
 * nothing about this Nextcloud: no header of ours, no body.
 *
 * A failure comes back with a `reason` the setup page has a named message for,
 * next to the technical `error` for the log.
 */

'use strict';

const { assertAllowedUrl } = require('./remoteHost');
const { errMessage } = require('./errors');

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Why a probe failed:
 *   not_allowed  the address is one this connector does not contact
 *   certificate  the server's TLS certificate is not trusted here
 *   redirect     the address answers with a redirect
 *   http         a server answered, but not with a healthy status
 *   unreachable  no answer (name does not resolve, refused, timeout)
 * @typedef {'not_allowed' | 'certificate' | 'redirect' | 'http' | 'unreachable'} ProbeFailure
 *
 * @typedef {{ ok: boolean, status: number, url: string, error: string | null, reason?: ProbeFailure, version?: string | null, tier?: string | null }} ProbeResult
 */

// Node's codes for a certificate that does not verify (self-signed, unknown
// issuer, expired, wrong name).
const CERTIFICATE_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_UNTRUSTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Did this request fail on the server's certificate? fetch wraps the TLS error
 * as the `cause` of a generic "fetch failed".
 * @param {unknown} err
 * @returns {boolean}
 */
function isCertificateError(err) {
    /** @type {unknown} */
    let current = err;
    for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
        if ('code' in current && typeof current.code === 'string' && CERTIFICATE_CODES.has(current.code)) return true;
        current = 'cause' in current ? current.cause : null;
    }
    return false;
}

/**
 * Probe a Bee Flow service /api/health endpoint.
 * @param {string} url
 * @returns {Promise<ProbeResult>}
 */
async function probe(url) {
    // Validate before connecting — an admin-supplied hostname must not be able
    // to reach link-local/cloud-metadata infrastructure through the connector.
    try {
        await assertAllowedUrl(url, { label: 'Bee Flow server URL' });
    } catch (err) {
        return { ok: false, status: 0, url: String(url), error: errMessage(err), reason: 'not_allowed' };
    }
    const target = `${url.replace(/\/+$/, '')}/api/health`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
        // Redirects are NOT followed. A validated hostname that 302s to
        // 169.254.169.254 is the standard way round a host allow-list, and the
        // admin is better served by being told to enter the final URL anyway.
        const res = await fetch(target, { signal: ac.signal, redirect: 'manual' });
        clearTimeout(t);
        if (res.status >= 300 && res.status < 400) {
            return {
                ok: false,
                status: res.status,
                url: target,
                error: `the server redirected (HTTP ${res.status}) — enter the final URL directly`,
                reason: 'redirect',
            };
        }
        const text = await res.text();
        /** @type {{ version?: string, appVersion?: string, tier?: string } | null} */
        let body;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        return {
            ok: res.ok,
            status: res.status,
            url: target,
            version: body?.version || body?.appVersion || null,
            tier: body?.tier || null,
            error: res.ok ? null : `HTTP ${res.status}`,
            ...(res.ok ? {} : { reason: /** @type {ProbeFailure} */ ('http') }),
        };
    } catch (err) {
        clearTimeout(t);
        const timedOut = err instanceof Error && err.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            url: target,
            error: timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : errMessage(err),
            reason: !timedOut && isCertificateError(err) ? 'certificate' : 'unreachable',
        };
    }
}

module.exports = { probe, isCertificateError, REQUEST_TIMEOUT_MS };
