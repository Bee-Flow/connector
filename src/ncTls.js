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
 *
 * The self-signed mode is trust on first use, not "trust anything" (#403):
 * both agents check the certificate's key against the pin recorded for that
 * host (ncTlsPin.js) after the handshake and BEFORE the request is written,
 * and refuse a changed key. TLS session resumption is off on those agents so
 * every connection shows its full certificate chain.
 */

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('./config');
const { createPinStore } = require('./ncTlsPin');
const log = require('./log');
const { errMessage } = require('./errors');

const caFile = (process.env.BEEFLOW_NC_CA_FILE || '').trim();
const insecure = process.env.BEEFLOW_NC_TLS_INSECURE === '1';

// Connection options applied to the Nextcloud origin only. null ⇒ default
// (verify normally).
/** @type {{ ca?: Buffer, rejectUnauthorized?: boolean } | null} */
let connectOpts = null;
/** @type {'default' | 'ca' | 'insecure'} */
let mode = 'default';
if (caFile) {
    try {
        connectOpts = { ca: fs.readFileSync(caFile) };
        mode = 'ca';
    } catch (e) {
        log.warn(`[ncTls] could not read BEEFLOW_NC_CA_FILE (${caFile}): ${errMessage(e)} — keeping strict verification`);
    }
} else if (insecure) {
    connectOpts = { rejectUnauthorized: false };
    mode = 'insecure';
}

/**
 * Set of NC origins (internal + public) whose TLS posture we override.
 * @returns {Set<string>}
 */
function ncOrigins() {
    /** @type {Set<string>} */
    const set = new Set();
    for (const u of [config.nextcloudUrl, config.nextcloudPublicUrl]) {
        if (!u) continue;
        try { set.add(new URL(u).origin); } catch { /* ignore malformed */ }
    }
    return set;
}

/** @typedef {ReturnType<typeof createPinStore>} PinStore */

/** @type {PinStore | null} */
let _pinStore = null;

/**
 * The certificate pins of the self-signed mode, loaded on first use.
 * @returns {PinStore}
 */
function pinStore() {
    if (!_pinStore) {
        _pinStore = createPinStore({ file: path.join(config.persistentStorage, 'nc-trust', 'pins.json'), log });
    }
    return _pinStore;
}

/**
 * `host:port` of a connection, the key a pin is stored under.
 * @param {{ host?: string | null, hostname?: string | null, port?: string | number | null }} opts
 */
function hostKeyOf(opts) {
    const host = String(opts.hostname || opts.host || '').replace(/^\[|\]$/g, '').toLowerCase();
    return `${host}:${opts.port || 443}`;
}

/**
 * An https.Agent that checks the pin before the request is written. Node's
 * http client attaches a request to the socket only once createConnection's
 * callback runs, so a refused connection never sees a header.
 * @param {https.AgentOptions} options
 * @param {() => PinStore} store
 * @returns {https.Agent}
 */
function pinnedHttpsAgent(options, store) {
    class PinnedAgent extends https.Agent {
        /**
         * The callback form of createConnection, which Node's Agent waits for.
         * @param {import('http').RequestOptions} opts
         * @param {(err: Error | null, stream: import('stream').Duplex) => void} [cb]
         * @returns {undefined}
         */
        createConnection(opts, cb) {
            const socket = /** @type {import('tls').TLSSocket} */ (super.createConnection(opts));
            let done = false;
            /** @param {Error | null} err */
            const finish = (err) => {
                if (done) return;
                done = true;
                if (err) socket.destroy();
                cb?.(err, socket);
            };
            socket.once('secureConnect', () => finish(store().check(hostKeyOf(opts), socket)));
            socket.once('error', (err) => finish(err));
            return undefined;
        }
    }
    return new PinnedAgent({ ...options, maxCachedSessions: 0 });
}

/**
 * An undici connector that checks the pin before undici writes the request.
 * @param {typeof import('undici')} undici
 * @param {import('undici').buildConnector.BuildOptions} connectOptions
 * @param {() => PinStore} store
 * @returns {import('undici').buildConnector.connector}
 */
function pinnedConnector(undici, connectOptions, store) {
    const base = undici.buildConnector({ ...connectOptions, maxCachedSessions: 0 });
    return (opts, callback) => base(opts, (err, socket) => {
        if (err || !socket) return callback(err || new Error('no socket'), null);
        if (opts.protocol !== 'https:') return callback(null, socket);
        const refused = store().check(hostKeyOf(opts), /** @type {import('tls').TLSSocket} */ (socket));
        if (refused) { socket.destroy(); return callback(refused, null); }
        return callback(null, socket);
    });
}

// https.Agent for the /nc/* reverse proxy (http-proxy-middleware). When the
// posture is default this is a plain keep-alive-off agent (same as before).
const ncHttpsAgent = mode === 'insecure'
    ? pinnedHttpsAgent({ keepAlive: false, ...connectOpts }, pinStore)
    : connectOpts
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

    /** @type {typeof import('undici')} */
    let undici;
    try {
        undici = require('undici');
    } catch (e) {
        // undici is a declared dependency, so this should not happen. If it
        // ever does, fail safe-ish: for the self-signed case, relax globally as
        // a last resort so the connector can still bootstrap (clearly logged);
        // for CA-pinning there is no global equivalent, so stay strict.
        if (mode === 'insecure') {
            log.warn('[ncTls] undici unavailable — falling back to process-global TLS relaxation (Nextcloud bootstrap will work but other TLS verification is also relaxed)');
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        } else {
            log.warn(`[ncTls] undici unavailable — cannot scope NC TLS (${errMessage(e)}); keeping strict verification`);
        }
        return;
    }

    const { Agent, Dispatcher, setGlobalDispatcher, getGlobalDispatcher } = undici;
    const origins = ncOrigins();
    const ncAgent = new Agent({
        connect: mode === 'insecure' ? pinnedConnector(undici, connectOpts, pinStore) : connectOpts,
    });
    const base = getGlobalDispatcher();

    class NcRouter extends Dispatcher {
        /**
         * @param {import('undici').Dispatcher.DispatchOptions} opts
         * @param {import('undici').Dispatcher.DispatchHandler} handler
         */
        dispatch(opts, handler) {
            let origin = opts.origin;
            if (origin && typeof origin !== 'string') origin = origin.origin;
            return (origins.has(String(origin)) ? ncAgent : base).dispatch(opts, handler);
        }
        // close() and destroy() have the promise form and the callback form (undici's
        // Dispatcher declares both), so the overloads are spelled out; the router only
        // forwards to the two dispatchers it fronts.
        /**
         * @overload
         * @returns {Promise<void>}
         */
        /**
         * @overload
         * @param {() => void} callback
         * @returns {void}
         */
        /**
         * @param {() => void} [callback]
         * @returns {Promise<void> | void}
         */
        close(callback) {
            const done = (async () => { await ncAgent.close(); if (base.close) await base.close(); })();
            if (!callback) return done;
            done.then(callback, callback);
        }
        /**
         * @overload
         * @returns {Promise<void>}
         */
        /**
         * @overload
         * @param {Error | null} err
         * @returns {Promise<void>}
         */
        /**
         * @overload
         * @param {() => void} callback
         * @returns {void}
         */
        /**
         * @overload
         * @param {Error | null} err
         * @param {() => void} callback
         * @returns {void}
         */
        /**
         * @param {Error | null | (() => void)} [errOrCallback]
         * @param {() => void} [callback]
         * @returns {Promise<void> | void}
         */
        destroy(errOrCallback, callback) {
            const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
            const cb = typeof errOrCallback === 'function' ? errOrCallback : callback;
            const done = (async () => { await ncAgent.destroy(err); if (base.destroy) await base.destroy(err); })();
            if (!cb) return done;
            done.then(cb, cb);
        }
    }

    setGlobalDispatcher(new NcRouter());
    log.info(`[ncTls] scoped Nextcloud TLS posture: ${mode}${mode === 'insecure' ? ' (certificate pinned on first use)' : ''} for ${[...origins].join(', ')} — all other TLS stays verified`);
}

module.exports = { ncHttpsAgent, installNcDispatcher, ncTlsMode: mode, ncOrigins, pinStore, pinnedHttpsAgent, pinnedConnector, hostKeyOf };
