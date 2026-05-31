/**
 * Scoped Nextcloud TLS posture (runtime).
 *
 * Companion to scripts/ncTlsTrust.js (the boot helper), which decides whether
 * this Nextcloud's certificate is trusted and writes one of these env vars,
 * sourced by the entrypoint before the connector starts:
 *
 *   BEEFLOW_NC_CA_FILE=<path>   pin an explicit CA (verification stays ON)
 *   BEEFLOW_NC_TLS_INSECURE=1   Nextcloud uses a self-signed / internal cert;
 *                               trust it for the NC origin ONLY
 *
 * Why a custom global dispatcher (not NODE_TLS_REJECT_UNAUTHORIZED)
 * ────────────────────────────────────────────────────────────────
 * The connector talks TLS to two kinds of peers: the customer's Nextcloud and
 * the Bee Flow server. A blunt NODE_TLS_REJECT_UNAUTHORIZED=0 would disable
 * verification for BOTH. Instead we install an undici dispatcher that routes
 * requests to the Nextcloud origin(s) through a relaxed Agent and EVERYTHING
 * ELSE through the normal verifying dispatcher. Verified empirically: a public
 * self-signed cert (badssl) still fails after this is installed — the scope
 * does not leak. Node's built-in global `fetch` honours the undici package's
 * setGlobalDispatcher (shared global symbol), so all NC-bound fetches in
 * bootstrap.js / heartbeat.js / declarativeSettings.js / auth.js are covered
 * with no per-call changes. The /nc/* reverse proxy (http-proxy-middleware,
 * not fetch) uses `ncHttpsAgent` below.
 *
 * A trusted public / Let's Encrypt Nextcloud (the production and real-AIO
 * case) sets neither env var → this module is a no-op and verification is full.
 */

'use strict';

const fs = require('fs');
const https = require('https');
const config = require('./config');

const caFile = (process.env.BEEFLOW_NC_CA_FILE || '').trim();
const insecure = process.env.BEEFLOW_NC_TLS_INSECURE === '1';

// Connection options applied to the Nextcloud origin only. null ⇒ default
// (verify normally).
let connectOpts = null;
let mode = 'default';
if (caFile) {
    try {
        connectOpts = { ca: fs.readFileSync(caFile) };
        mode = 'ca';
    } catch (e) {
        console.warn(`[ncTls] could not read BEEFLOW_NC_CA_FILE (${caFile}): ${e.message} — keeping strict verification`);
    }
} else if (insecure) {
    connectOpts = { rejectUnauthorized: false };
    mode = 'insecure';
}

/** Set of NC origins (internal + public) whose TLS posture we override. */
function ncOrigins() {
    const set = new Set();
    for (const u of [config.nextcloudUrl, config.nextcloudPublicUrl]) {
        if (!u) continue;
        try { set.add(new URL(u).origin); } catch { /* ignore malformed */ }
    }
    return set;
}

// https.Agent for the /nc/* reverse proxy (http-proxy-middleware). When the
// posture is default this is a plain keep-alive-off agent (same as before).
const ncHttpsAgent = connectOpts
    ? new https.Agent({ keepAlive: false, ...connectOpts })
    : new https.Agent({ keepAlive: false });

let installed = false;

/**
 * Install the origin-scoped global dispatcher for Node's built-in fetch. Safe
 * to call once at boot before any NC fetch; a no-op when posture is default or
 * when already installed.
 */
function installNcDispatcher() {
    if (installed || !connectOpts) return;
    installed = true;

    let undici;
    try {
        undici = require('undici');
    } catch (e) {
        // undici is a declared dependency, so this should not happen. If it
        // ever does, fail safe-ish: for the self-signed case, relax globally as
        // a last resort so the connector can still bootstrap (clearly logged);
        // for CA-pinning there is no global equivalent, so stay strict.
        if (mode === 'insecure') {
            console.warn('[ncTls] undici unavailable — falling back to process-global TLS relaxation (Nextcloud bootstrap will work but other TLS verification is also relaxed)');
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        } else {
            console.warn(`[ncTls] undici unavailable — cannot scope NC TLS (${e.message}); keeping strict verification`);
        }
        return;
    }

    const { Agent, Dispatcher, setGlobalDispatcher, getGlobalDispatcher } = undici;
    const origins = ncOrigins();
    const ncAgent = new Agent({ connect: connectOpts });
    const base = getGlobalDispatcher();

    class NcRouter extends Dispatcher {
        dispatch(opts, handler) {
            let origin = opts.origin;
            if (origin && typeof origin !== 'string') origin = origin.origin;
            return (origins.has(origin) ? ncAgent : base).dispatch(opts, handler);
        }
        async close() { await ncAgent.close(); if (base.close) await base.close(); }
        async destroy(err) { await ncAgent.destroy(err); if (base.destroy) await base.destroy(err); }
    }

    setGlobalDispatcher(new NcRouter());
    console.log(`[ncTls] scoped Nextcloud TLS posture: ${mode} for ${[...origins].join(', ')} — all other TLS stays verified`);
}

module.exports = { ncHttpsAgent, installNcDispatcher, ncTlsMode: mode, ncOrigins };
