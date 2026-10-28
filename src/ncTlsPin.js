/**
 * Trust on first use for the self-signed Nextcloud TLS mode (#403).
 *
 * BEEFLOW_NC_TLS_INSECURE=1 (see ncTlsTrust.js) used to accept ANY
 * certificate for the Nextcloud origin. Anyone who could intercept the
 * connector's traffic to Nextcloud then saw the AppAPI app secret on every
 * call. Now the first certificate the connector sees for a Nextcloud host is
 * recorded by the SHA-256 of its public key (SPKI), and every later
 * connection must present that same key, or it is refused before a single
 * byte of the request is sent.
 *
 * What is pinned: the top of the presented chain that the leaf verifiably
 * chains up to (signature by signature). For a self-signed certificate that
 * is the certificate itself. Behind an internal CA that sends its
 * intermediate, it is that intermediate, so a routine leaf renewal under the
 * same CA keeps working; a connection is accepted when any key in its
 * verified chain is pinned. (An internal CA is better served by
 * BEEFLOW_NC_CA_CERT, which verifies properly; the refusal says so.)
 *
 * A changed key is refused, logged once, and remembered as PENDING. An admin
 * accepts it explicitly: on the connector's /setup page (it names the new key
 * and must be confirmed with that key), or by deleting the pin file and
 * restarting the connector, which pins afresh on first use.
 *
 * The pin file lives in the connector's persistent storage, next to the
 * other TLS state (`nc-trust/`), so it survives restarts and updates.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PIN_MISMATCH = 'NC_TLS_PIN_MISMATCH';

/**
 * @typedef {{ spki: string, since: string }} Pin
 * @typedef {{ spki: string, seenAt: string }} Pending
 * @typedef {{ pins: Record<string, Pin>, pending: Record<string, Pending> }} PinState
 * @typedef {{ info: (msg: string) => void, warn: (msg: string) => void }} PinLog
 *
 * The part of a TLS socket this module reads (a tls.TLSSocket in practice).
 * @typedef {{ getPeerCertificate: (detailed: true) => import('tls').DetailedPeerCertificate }} PeerSocket
 */

/**
 * `sha256/<base64>` of a certificate's SubjectPublicKeyInfo: the form HPKP
 * and most tooling print, so an admin can compare it with
 * `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`.
 * @param {crypto.X509Certificate} cert
 * @returns {string}
 */
function spkiPin(cert) {
    const der = cert.publicKey.export({ type: 'spki', format: 'der' });
    return `sha256/${crypto.createHash('sha256').update(der).digest('base64')}`;
}

/**
 * The SPKI pins of the presented chain, leaf first, as far as each
 * certificate is verifiably signed by the next one. A peer cannot extend
 * this list with a certificate it holds no key for.
 * @param {PeerSocket} socket
 * @returns {string[]}
 */
function verifiedChainPins(socket) {
    const peer = socket.getPeerCertificate(true);
    if (!peer || !peer.raw) return [];
    /** @type {crypto.X509Certificate[]} */
    const chain = [new crypto.X509Certificate(peer.raw)];
    /** @type {Set<string>} */
    const seen = new Set([chain[0].fingerprint256]);
    let node = peer;
    while (node.issuerCertificate && node.issuerCertificate.raw) {
        const parent = new crypto.X509Certificate(node.issuerCertificate.raw);
        if (seen.has(parent.fingerprint256)) break; // a self-signed root points at itself
        const child = chain[chain.length - 1];
        if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) break;
        chain.push(parent);
        seen.add(parent.fingerprint256);
        node = node.issuerCertificate;
    }
    return chain.map(spkiPin);
}

/**
 * @param {unknown} err
 * @returns {boolean} true when `err` (or a cause of it, e.g. fetch's TypeError) is a pin refusal
 */
function isPinMismatch(err) {
    for (let e = err, i = 0; e && typeof e === 'object' && i < 5; i++) {
        if ('code' in e && e.code === PIN_MISMATCH) return true;
        e = 'cause' in e ? e.cause : null;
    }
    return false;
}

/**
 * @param {{ file: string, log: PinLog, now?: () => Date }} opts
 */
function createPinStore({ file, log, now = () => new Date() }) {
    /** @type {PinState} */
    let state = { pins: {}, pending: {} };
    try {
        const raw = /** @type {Partial<PinState>} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
        state = { pins: { ...(raw.pins || {}) }, pending: { ...(raw.pending || {}) } };
    } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        // A corrupt file must not silently re-pin whatever answers next.
        if (code !== 'ENOENT') {
            log.warn(`[ncTls] could not read the certificate pins (${file}); refusing every new Nextcloud TLS connection until it is fixed or deleted`);
            return lockedStore(file);
        }
    }

    function save() {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    }

    /** @type {Set<string>} keys of `host:port|spki` already reported */
    const reported = new Set();

    /**
     * Decide one connection. Records the first key per host, refuses a
     * changed one. Returns null to proceed, or the Error to fail with.
     * @param {string} hostKey  `host:port`
     * @param {PeerSocket} socket
     * @returns {Error | null}
     */
    function check(hostKey, socket) {
        /** @type {string[]} */
        let chain;
        try {
            chain = verifiedChainPins(socket);
        } catch {
            chain = [];
        }
        if (!chain.length) return refusal(hostKey, 'the server presented no readable certificate');
        const pinned = state.pins[hostKey];
        if (!pinned) {
            const spki = chain[chain.length - 1];
            state.pins[hostKey] = { spki, since: now().toISOString() };
            try { save(); } catch (err) {
                log.warn(`[ncTls] could not store the certificate pin for ${hostKey} (kept in memory until restart): ${err instanceof Error ? err.message : String(err)}`);
            }
            log.info(`[ncTls] pinned Nextcloud's certificate for ${hostKey} on first use: ${spki}`);
            return null;
        }
        if (chain.includes(pinned.spki)) return null;

        const presented = chain[chain.length - 1];
        if (state.pending[hostKey]?.spki !== presented) {
            state.pending[hostKey] = { spki: presented, seenAt: now().toISOString() };
            try { save(); } catch { /* the refusal stands either way */ }
        }
        if (!reported.has(`${hostKey}|${presented}`)) {
            reported.add(`${hostKey}|${presented}`);
            log.warn(`[ncTls] Nextcloud's certificate for ${hostKey} CHANGED: pinned ${pinned.spki}, now ${presented}. `
                + 'Refusing the connection; nothing is sent over it. If you renewed the certificate, accept the new one '
                + 'on the Bee Flow connector\'s setup page (Nextcloud certificate) or delete '
                + `${file} and restart the connector. If Nextcloud uses an internal CA, set BEEFLOW_NC_CA_CERT to its root certificate instead.`);
        }
        return refusal(hostKey, `certificate key ${presented} does not match the pinned ${pinned.spki}`);
    }

    /**
     * Accept the pending key of a host, named by the key itself so a stale
     * confirmation can never accept a different certificate.
     * @param {string} spki
     * @returns {string[]} the hosts whose pin moved to `spki`
     */
    function accept(spki) {
        /** @type {string[]} */
        const hosts = [];
        for (const [hostKey, p] of Object.entries(state.pending)) {
            if (p.spki !== spki) continue;
            const before = state.pins[hostKey]?.spki || '(none)';
            state.pins[hostKey] = { spki, since: now().toISOString() };
            delete state.pending[hostKey];
            hosts.push(hostKey);
            log.warn(`[ncTls] an administrator accepted Nextcloud's new certificate for ${hostKey}: ${before} → ${spki}`);
        }
        if (hosts.length) save();
        return hosts;
    }

    /** @returns {PinState} a copy, for the setup page */
    function snapshot() {
        return { pins: { ...state.pins }, pending: { ...state.pending } };
    }

    return { check, accept, snapshot, file };
}

/**
 * A store that refuses everything: the pin file exists but cannot be read.
 * @param {string} file
 */
function lockedStore(file) {
    return {
        /** @param {string} hostKey @returns {Error} */
        check: (hostKey) => refusal(hostKey, `the pin file ${file} is unreadable`),
        /** @returns {string[]} */
        accept: () => [],
        /** @returns {PinState} */
        snapshot: () => ({ pins: {}, pending: {} }),
        file,
    };
}

/**
 * @param {string} hostKey
 * @param {string} why
 * @returns {Error}
 */
function refusal(hostKey, why) {
    const err = new Error(`Nextcloud TLS pin check failed for ${hostKey}: ${why}`);
    err.code = PIN_MISMATCH;
    return err;
}

module.exports = { createPinStore, verifiedChainPins, spkiPin, isPinMismatch, PIN_MISMATCH };
