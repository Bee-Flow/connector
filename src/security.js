/**
 * Response hardening + cross-site request rejection.
 *
 * A PHP Nextcloud app gets most of this for free: `OC_Template` emits
 * `X-Frame-Options`, the app framework rejects a request with no CSRF token
 * unless the controller opts out, and `ITrustedDomainHelper` answers "is this
 * URL really us?". An ExApp is a separate HTTP server behind AppAPI's proxy and
 * gets none of it, so the same three guarantees are rebuilt here:
 *
 *   https://docs.nextcloud.com/server/latest/developer_manual/prologue/security.html
 *   https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/security.html
 *
 * 1. TRUSTED EMBED ORIGINS (clickjacking + the ITrustedDomainHelper role)
 *    The SPA renders inside an iframe on the Nextcloud page, so the response
 *    must name that origin in `frame-ancestors`. Which origin the *browser*
 *    uses is not always NEXTCLOUD_URL — that value can be a Docker-internal
 *    hostname while the user is on the customer domain. The previous
 *    implementation solved this by echoing the request's own Origin/Referer
 *    into the header, which means any site that framed the connector named
 *    itself as an allowed framer: the header permitted precisely the attack it
 *    exists to stop. Now a forwarded origin is honoured only when it is on the
 *    trusted list, and an unlisted one is logged once with the env var that
 *    fixes it.
 *
 * 2. CROSS-SITE REQUESTS (CSRF)
 *    AppAPI's proxy controller is `#[NoCSRFRequired]`, so Nextcloud does not
 *    check a token on anything forwarded here — the connector is the only place
 *    the check can happen. `Sec-Fetch-Site` is set by the browser itself, cannot
 *    be written by page script, and answers exactly this question. Absent (a
 *    server-to-server caller: Nextcloud's webhook job, Talk, the Bee Flow
 *    server) the request is judged on its own signature instead, which those
 *    routes all verify.
 *
 * 3. RESPONSE HEADERS
 *    nosniff, no-referrer and noindex on everything the connector emits.
 */

'use strict';

const config = require('./config');

function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
}

/**
 * Origins allowed to frame the connector: the Nextcloud this ExApp is installed
 * in (internal and public URL), plus anything the admin adds explicitly.
 *
 * BEEFLOW_TRUSTED_EMBED_ORIGINS is a comma-separated list. It is needed only
 * when the browser reaches Nextcloud on an origin the connector never sees —
 * a reverse proxy in front of NC, or a dev box where NEXTCLOUD_URL is
 * `http://host.docker.internal` while the browser is on `http://localhost`.
 */
function trustedEmbedOrigins() {
    const set = new Set();
    for (const u of [config.nextcloudUrl, config.nextcloudPublicUrl]) {
        const o = originOf(u);
        if (o) set.add(o);
    }
    for (const raw of String(process.env.BEEFLOW_TRUSTED_EMBED_ORIGINS || '').split(',')) {
        const o = originOf(raw.trim());
        if (o) set.add(o);
    }
    return set;
}

// One line per unknown origin, not one per request: a misconfigured reverse
// proxy would otherwise fill the log at the rate the SPA polls.
const _loggedUnknownOrigins = new Set();

function frameAncestorsFor(req) {
    const trusted = trustedEmbedOrigins();
    const ancestors = new Set(["'self'", ...trusted]);
    for (const hdr of ['origin', 'referer']) {
        const value = req.headers?.[hdr];
        if (!value) continue;
        const origin = originOf(value);
        if (!origin) continue;
        if (trusted.has(origin)) continue; // already listed
        if (!_loggedUnknownOrigins.has(origin)) {
            _loggedUnknownOrigins.add(origin);
            console.warn(`[Security] refusing to allow ${origin} to frame this app — it is not this `
                + `Nextcloud's origin. If the app is embedded there legitimately, add it to `
                + `BEEFLOW_TRUSTED_EMBED_ORIGINS (occ app_api:app:setenv ${config.appId} `
                + `BEEFLOW_TRUSTED_EMBED_ORIGINS ${origin}).`);
        }
    }
    return [...ancestors].join(' ');
}

/** Headers every connector response carries. */
function securityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestorsFor(req)}`);
    // The embedded app is served from this origin; a mistyped Content-Type on a
    // proxied response must not be allowed to become script.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing downstream needs to know which Nextcloud page linked here, and the
    // path can carry a file id or a conversation token.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The connector is reachable through Nextcloud's public URL; none of it
    // belongs in a search index.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reject state-changing requests a browser made from another site.
 *
 * `Sec-Fetch-Site: cross-site` is the browser's own statement that the
 * initiator was a different site — it cannot be set by fetch(), XHR or a form.
 * Everything else (same-origin, same-site, none, or a request with no such
 * header at all) passes and is authenticated by whatever that route requires.
 */
function rejectCrossSiteWrites(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const site = req.headers['sec-fetch-site'];
    if (site !== 'cross-site') return next();
    console.warn(`[Security] blocked cross-site ${req.method} ${req.path} `
        + `(origin: ${req.headers.origin || 'unknown'})`);
    return res.status(403).json({
        ok: false,
        code: 'cross_site_request_blocked',
        error: 'Cross-site requests are not accepted by this app.',
    });
}

module.exports = {
    securityHeaders,
    rejectCrossSiteWrites,
    trustedEmbedOrigins,
    frameAncestorsFor,
    _resetOriginLog: () => _loggedUnknownOrigins.clear(),
};
