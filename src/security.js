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
const rateLimit = require('./rateLimit');

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
//
// The thing being remembered is a REQUEST HEADER, so the key is chosen by the
// caller and must never be allowed to accumulate. `securityHeaders` is the first
// middleware in server.js, which means every request reaches this code —
// including the ones the AppAPI gate rejects a moment later — so an unbounded
// `Set` here was reachable without any credential: a caller varying
// `Origin`/`Referer` bought permanently-retained heap (measured: 20k requests
// with 4 kB headers ⇒ 159 MB, never reclaimed) and one log line per distinct
// origin, i.e. the dedup that exists to prevent log flooding became the flood.
//
// Both are bounded now, with the limiter this project already has:
//   * the "seen" set is a rateLimit bucket — the same bounded keyed map used for
//     every other caller-supplied key here (MAX_KEYS_PER_BUCKET, swept lazily,
//     oldest key dropped first, so churn forgets an old origin rather than
//     growing);
//   * an over-long origin is not remembered verbatim at all — it collapses onto
//     one constant key, so a 16 kB header never becomes a long-lived string
//     (truncating it would not help: a `slice` keeps the whole parent alive);
//   * a second bucket caps how many lines origin churn can emit AT ALL, so
//     200k distinct origins cost ORIGIN_LOG_MAX_LINES lines, not 200k.
//
// Re-logging the same origin once the window rolls over is deliberate: the line
// names the `occ` command that fixes the misconfiguration, and an operator
// looking at a fresh log window should still find it.
const ORIGIN_LOG_WINDOW_MS = 60 * 60 * 1000;
const ORIGIN_LOG_MAX_LINES = 10;
// Comfortably longer than any real origin (scheme + 253-byte hostname + port).
// Nothing above this is a misconfigured reverse proxy — it is padding.
const MAX_ORIGIN_KEY_LEN = 300;
const OVERSIZED_ORIGIN_KEY = '(oversized origin header)';

function shouldWarnAboutOrigin(key) {
    // Once per origin per window …
    const seen = rateLimit.consume('embed-origin-seen', key,
        { limit: 1, windowMs: ORIGIN_LOG_WINDOW_MS });
    if (!seen.allowed) return false;
    // … and never more than a handful of lines per window in total.
    return rateLimit.consume('embed-origin-log', 'global',
        { limit: ORIGIN_LOG_MAX_LINES, windowMs: ORIGIN_LOG_WINDOW_MS }).allowed;
}

function frameAncestorsFor(req) {
    const trusted = trustedEmbedOrigins();
    const ancestors = new Set(["'self'", ...trusted]);
    for (const hdr of ['origin', 'referer']) {
        const value = req.headers?.[hdr];
        if (!value) continue;
        const origin = originOf(value);
        if (!origin) continue;
        if (trusted.has(origin)) continue; // already listed
        const oversized = origin.length > MAX_ORIGIN_KEY_LEN;
        if (!shouldWarnAboutOrigin(oversized ? OVERSIZED_ORIGIN_KEY : origin)) continue;
        if (oversized) {
            console.warn(`[Security] ignoring an oversized ${hdr} header (${origin.length} bytes) — `
                + 'no real origin is that long, so it is neither listed in frame-ancestors nor '
                + 'remembered.');
            continue;
        }
        console.warn(`[Security] refusing to allow ${origin} to frame this app — it is not this `
            + `Nextcloud's origin. If the app is embedded there legitimately, add it to `
            + `BEEFLOW_TRUSTED_EMBED_ORIGINS (occ app_api:app:setenv ${config.appId} `
            + `BEEFLOW_TRUSTED_EMBED_ORIGINS ${origin}).`);
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
    // Test-only: the unknown-origin log state lives in rateLimit's buckets now,
    // so clearing it is clearing those.
    _resetOriginLog: () => rateLimit.reset(),
    ORIGIN_LOG_MAX_LINES,
    MAX_ORIGIN_KEY_LEN,
};
