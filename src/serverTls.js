/**
 * Trust for the connection to the Bee Flow server.
 *
 * A self-hosted Bee Flow server may carry a certificate from a company
 * certificate authority, or a self-signed one. BEEFLOW_SERVER_CA_CERT (an
 * install-time value) names the certificate to trust for it: the PEM text
 * itself (one certificate or a chain), or the path of a PEM file inside the
 * container.
 *
 *   - The certificate is ADDED to the default roots. A Bee Flow server with a
 *     certificate from a public authority keeps working with the value set.
 *   - It applies to the connection to the Bee Flow server only. Nextcloud
 *     origins keep their own posture (ncTls.js) and never see it.
 *   - Verification is always on. There is no value that switches it off; an
 *     unusable value is logged and ignored, so the default roots apply.
 *
 * Two kinds of client make that connection, and both read from here: Node's
 * fetch (the dispatcher ncTls.js installs asks `fetchConnectOptions`) and the
 * http(s) agents of the two proxies in proxy.js (`httpsAgentOptions`).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const tls = require('tls');
const log = require('./log');
const { errMessage } = require('./errors');

const ENV_NAME = 'BEEFLOW_SERVER_CA_CERT';
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/**
 * The certificates in a PEM text, each rebuilt with clean line breaks: a form
 * field may have turned the line breaks of a pasted certificate into spaces.
 * @param {string} text
 * @returns {string[]}
 */
function pemBlocks(text) {
    /** @type {string[]} */
    const out = [];
    for (const match of text.matchAll(PEM_BLOCK)) {
        const body = (match[1] || '').replace(/\\n/g, '').replace(/\s+/g, '');
        const lines = body.match(/.{1,64}/g) || [];
        out.push(`-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`);
    }
    return out;
}

/**
 * The certificates BEEFLOW_SERVER_CA_CERT names. Never throws: a value that
 * cannot be used gives an empty list and a warning.
 * @param {unknown} raw  the value of the variable
 * @param {{ warn?: (message: string) => void }} [opts]
 * @returns {string[]}  PEM certificates
 */
function readExtraCertificates(raw, opts = {}) {
    const warn = opts.warn || ((message) => log.warn(message));
    const value = String(raw || '').trim();
    if (!value) return [];
    let text = value;
    if (!value.includes('-----BEGIN')) {
        try {
            text = fs.readFileSync(value, 'utf8');
        } catch (err) {
            warn(`[ServerTls] ${ENV_NAME} is neither PEM text nor a readable file (${errMessage(err)}); only the default certificate authorities are trusted`);
            return [];
        }
    }
    /** @type {string[]} */
    const usable = [];
    for (const pem of pemBlocks(text)) {
        try {
            new crypto.X509Certificate(pem); // throws on anything that is not a certificate
            usable.push(pem);
        } catch (err) {
            warn(`[ServerTls] ${ENV_NAME} holds a certificate that cannot be read (${errMessage(err)}); it is ignored`);
        }
    }
    if (!usable.length) {
        warn(`[ServerTls] ${ENV_NAME} holds no usable certificate; only the default certificate authorities are trusted`);
    }
    return usable;
}

const extra = readExtraCertificates(process.env[ENV_NAME]);
// The roots Node trusts by default, plus the extra ones. null when there is
// nothing to add: the clients then run exactly as they do without this file.
/** @type {string[] | null} */
const serverCa = extra.length ? [...tls.getCACertificates('default'), ...extra] : null;
if (serverCa) {
    log.info(`[ServerTls] ${extra.length} certificate(s) from ${ENV_NAME} added to the default certificate authorities, for the connection to the Bee Flow server only`);
}

/**
 * The roots for a given list of extra certificates (the default roots first).
 * @param {string[]} certificates
 * @returns {string[]}
 */
function rootsWith(certificates) {
    return [...tls.getCACertificates('default'), ...certificates];
}

/** Is an extra certificate in use? */
function hasExtraCertificates() {
    return serverCa !== null;
}

/**
 * `connect` options for the undici agent that reaches the Bee Flow server;
 * null when there is nothing to add.
 * @returns {{ ca: string[] } | null}
 */
function fetchConnectOptions() {
    return serverCa ? { ca: serverCa } : null;
}

/**
 * Options to spread into the https.Agent of the proxies; empty when there is
 * nothing to add.
 * @returns {{ ca?: string[] }}
 */
function httpsAgentOptions() {
    return serverCa ? { ca: serverCa } : {};
}

module.exports = {
    ENV_NAME,
    readExtraCertificates,
    pemBlocks,
    rootsWith,
    hasExtraCertificates,
    fetchConnectOptions,
    httpsAgentOptions,
};
