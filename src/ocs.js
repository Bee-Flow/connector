/**
 * OCS response evaluation, shared across the connector's AppAPI OCS callers.
 *
 * Nextcloud's `/ocs/v1.php` answers HTTP 200 even when it REFUSES the request —
 * the real outcome lives in `ocs.meta.statuscode` in the body (100 = success on
 * the v1 envelope, 200 on v2, 409 = already registered). Reading only the HTTP
 * status is exactly what let 1.4.0 report "registered" for menu entries
 * Nextcloud had rejected outright, then persist them as done so they were never
 * retried. Every AppAPI OCS caller should judge success through here.
 *
 * Originally lived inline in studioAppMenus.js (the first place the bug was
 * fixed); lifted here so the top-menu, embed-script and settings-form
 * registrations use the same check.
 */

'use strict';

// OCS statuscodes that mean "the desired end state holds".
//   100 / 200 — success (v1 / v2 envelopes)
//   409       — already registered; re-running a sync must be idempotent
// On a DELETE, 404 additionally means "already gone".
const OCS_OK = new Set([100, 200, 409]);

/** Pull `ocs.meta.statuscode` out of a JSON *or* XML envelope; null if absent. */
function readOcsStatus(text) {
    try {
        const code = JSON.parse(text)?.ocs?.meta?.statuscode;
        if (Number.isFinite(code)) return code;
    } catch (_) { /* not JSON — try the XML shape below */ }
    const m = /<statuscode>(\d+)<\/statuscode>/.exec(text || '');
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Did this OCS call reach the desired end state? Judges BOTH the HTTP status and
 * the in-band `ocs.meta.statuscode`, because OCS coerces most refusals to HTTP
 * 200. When the body carries no envelope (`code === null`) the HTTP status is
 * all there is to go on.
 *
 * @param {{ok: boolean, status: number}} res  a fetch Response (only `ok`/`status` are read)
 * @param {string} text  the response body already read as text
 * @param {string} [method='POST']  the HTTP method, so DELETE can treat 404 as success
 * @returns {{ok: boolean, code: number|null}}
 */
function ocsSucceeded(res, text, method = 'POST') {
    const code = readOcsStatus(text);
    const httpOk = res.ok || res.status === 409 || (method === 'DELETE' && res.status === 404);
    const ocsOk = code === null
        ? httpOk // no envelope to read — the HTTP status is all we have
        : (OCS_OK.has(code) || (method === 'DELETE' && code === 404));
    return { ok: httpOk && ocsOk, code };
}

module.exports = { OCS_OK, readOcsStatus, ocsSucceeded };
