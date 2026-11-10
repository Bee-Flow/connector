#!/usr/bin/env node
/**
 * Nextcloud TLS posture decision — runs once at container start (before the
 * connector itself), invoked from scripts/harp-start.sh in ALL deploy modes
 * (manual-install, HaRP FRP-tunnel, HaRP exapp_direct).
 *
 * Why this exists
 * ───────────────
 * The connector reaches Nextcloud over HTTPS with Node's `fetch` (undici) in
 * bootstrap.js / heartbeat.js / ncProxy.js. Node ships its own CA bundle and
 * does NOT read the OS trust store, so a Nextcloud served with a self-signed
 * or internal-CA certificate (common on local / on-prem installs, e.g.
 * Nextcloud All-in-One behind a `tls internal` reverse proxy, or a `*.nip.io`
 * test domain) makes every NC-bound fetch fail with a cert error — the app
 * can never finish bootstrap and its top-bar icon never registers.
 *
 * AppAPI only injects env vars DECLARED in info.xml into the container, so an
 * undeclared `NODE_TLS_REJECT_UNAUTHORIZED=0` passed at register time is
 * silently dropped — the fix has to live in the connector, not in deploy flags.
 *
 * What it does (secure by default, scoped)
 * ────────────────────────────────────────
 * This script only *decides*. The actual TLS handling is applied at runtime by
 * src/ncTls.js, which relaxes verification for the Nextcloud origin ONLY — the
 * Bee Flow server channel and every other TLS peer stay fully verified (proven:
 * a public self-signed cert still fails). The decision is written as env lines
 * to <persistent>/nc-trust/env, which the entrypoint sources before exec-ing
 * the connector.
 *
 *  1. If BEEFLOW_NC_CA_CERT is set → write it out and emit BEEFLOW_NC_CA_FILE.
 *     The connector pins exactly that CA (rejectUnauthorized stays on). Use this
 *     when you have your Nextcloud's *root* CA — fully secure, no blind trust.
 *  2. Otherwise do a STRICT handshake to NEXTCLOUD_URL (and BEEFLOW_NC_PUBLIC_URL
 *     when distinct). If it already verifies (valid public / Let's Encrypt cert
 *     — the real-AIO and production case) → emit nothing; verification stays
 *     full.
 *  3. If the strict handshake FAILS ON THE CERTIFICATE (self-signed / internal
 *     CA) and BEEFLOW_NC_TLS_PIN is not "off" → emit BEEFLOW_NC_TLS_INSECURE=1
 *     so the connector trusts that Nextcloud origin. "off" leaves verification
 *     strict (for security-strict environments that prefer a hard failure).
 *  4. If Nextcloud cannot be REACHED (refused, no DNS, timeout: AppAPI starts
 *     this container while Nextcloud itself may still be starting) the
 *     handshake is retried for a short while and, when it stays unreachable,
 *     nothing is emitted: verification stays strict. A connection failure used
 *     to be read as "self-signed", which put an install with a valid public
 *     certificate in the relaxed posture, and since the pinning of 1.6.6 also
 *     recorded a pin under that wrong decision (#453).
 *
 * Never throws fatally: a failure here must not stop the connector booting.
 */

'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');

const HANDSHAKE_TIMEOUT_MS = 8000;
// How long an unreachable Nextcloud is retried before the helper gives up and
// leaves verification strict, and the pause between attempts. Bounded: the
// connector (and its /heartbeat) only starts once this helper has exited.
const PROBE_BUDGET_MS = Math.max(0, Number(process.env.BEEFLOW_NC_TLS_PROBE_BUDGET_MS) || 30_000);
const PROBE_RETRY_DELAY_MS = 3_000;

// OpenSSL / Node verification failures: the handshake reached a server that
// presented a certificate the bundled roots do not trust (or one that does not
// name this host). Only these mean "untrusted certificate"; everything else
// (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ETIMEDOUT, ECONNRESET, EPROTO from a
// plain-HTTP port, the timeout above) means "could not tell".
const CERT_ERROR_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_REVOKED',
    'CERT_SIGNATURE_FAILURE', 'CERT_CHAIN_TOO_LONG', 'INVALID_CA', 'INVALID_PURPOSE',
    'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Did this handshake error come from certificate verification?
 * @param {unknown} err
 * @returns {boolean}
 */
function isCertError(err) {
    if (!err || typeof err !== 'object') return false;
    const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
    if (CERT_ERROR_CODES.has(code)) return true;
    // Node prefixes some verify failures (e.g. `ERR_TLS_CERT_ALTNAME_INVALID`)
    // and OpenSSL spells new ones with the same stems.
    return /^(CERT_|ERR_TLS_CERT_|UNABLE_TO_(GET|VERIFY|DECRYPT)|SELF_SIGNED|DEPTH_ZERO)/.test(code);
}

/** @param {string} msg */
function log(msg) {
    process.stderr.write(`[nc-tls-trust] ${msg}\n`);
}

/**
 * One TLS handshake. Resolves { ok, authorized, error }.
 *  - strict=true → rejectUnauthorized:true; the secureConnect callback only
 *    fires when the certificate verifies, so ok && authorized ⇒ trusted.
 *  - caPems (optional) → trust these PEM CA(s) IN ADDITION to Node's bundled
 *    roots for this check (used to test an explicit / HaRP-mounted CA).
 *
 * @typedef {{ ok: true, authorized: boolean } | { ok: false, error: Error }} HandshakeResult
 * @param {string} host
 * @param {number} port
 * @param {string | undefined} servername
 * @param {boolean} strict
 * @param {readonly string[]} [caPems]
 * @returns {Promise<HandshakeResult>}
 */
function handshake(host, port, servername, strict, caPems) {
    return new Promise((resolve) => {
        let settled = false;
        /** @param {HandshakeResult} v */
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        // SNI must be a hostname, never an IP literal (RFC 6066).
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(servername || '') || (servername || '').includes(':');
        /** @type {import('node:tls').ConnectionOptions} */
        const opts = { host, port, rejectUnauthorized: strict, timeout: HANDSHAKE_TIMEOUT_MS };
        if (servername && !isIp) opts.servername = servername;
        if (caPems && caPems.length) {
            // tls `ca` REPLACES the defaults, so include the bundled roots too.
            opts.ca = [...tls.rootCertificates, ...caPems];
        }
        const socket = tls.connect(opts, () => {
            const authorized = socket.authorized;
            socket.end();
            done({ ok: true, authorized });
        });
        socket.on('error', (err) => done({ ok: false, error: err }));
        socket.on('timeout', () => { socket.destroy(); done({ ok: false, error: new Error('handshake timeout') }); });
        // A peer that closes mid-handshake without a TLS alert (a plain-HTTP
        // port, a proxy still starting) emits no 'error'; without this the
        // helper, and the connector behind it, never started.
        socket.on('close', () => done({ ok: false, error: Object.assign(new Error('connection closed during handshake'), { code: 'ECONNCLOSED' }) }));
    });
}

/** PEM CAs HaRP / AppAPI may mount when NC is reached over a non-public CA. */
/** @returns {string[]} */
function mountedCaPems() {
    const dir = '/usr/local/share/ca-certificates';
    /** @type {string[]} */
    const out = [];
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.crt')) continue;
            try { out.push(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip */ }
        }
    } catch { /* dir absent — normal */ }
    return out;
}

/**
 * One strict probe of every target with the given extra CAs.
 *   'trusted'     every certificate verifies
 *   'untrusted'   at least one server answered with a certificate that does not
 *   'unreachable' no certificate problem was seen, but a target could not be reached
 * @typedef {'trusted' | 'untrusted' | 'unreachable'} Verdict
 * @param {readonly TlsTarget[]} targets
 * @param {readonly string[]} caPems
 * @returns {Promise<{ verdict: Verdict, detail: string }>}
 */
async function probe(targets, caPems) {
    let unreachable = '';
    for (const t of targets) {
        const s = await handshake(t.host, t.port, t.servername, true, caPems);
        if (s.ok && s.authorized) continue;
        if (s.ok) return { verdict: 'untrusted', detail: `${t.key}: certificate not authorized` };
        if (!s.ok && isCertError(s.error)) {
            const code = /** @type {{ code?: string }} */ (s.error).code || s.error.message;
            return { verdict: 'untrusted', detail: `${t.key}: ${code}` };
        }
        if (!s.ok && !unreachable) {
            const code = /** @type {{ code?: string }} */ (s.error).code || s.error.message;
            unreachable = `${t.key}: ${code}`;
        }
    }
    return unreachable ? { verdict: 'unreachable', detail: unreachable } : { verdict: 'trusted', detail: '' };
}

/**
 * True when every target's certificate verifies with the given extra CAs.
 * An unreachable target counts as "does not verify" here; decide() asks probe()
 * directly where the difference matters.
 * @param {readonly TlsTarget[]} targets
 * @param {readonly string[]} caPems
 * @returns {Promise<boolean>}
 */
async function verifiesWith(targets, caPems) {
    return (await probe(targets, caPems)).verdict === 'trusted';
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * probe() against the public roots, retried while Nextcloud is unreachable
 * until PROBE_BUDGET_MS has passed. Returns the last verdict.
 * @param {readonly TlsTarget[]} targets
 * @param {{ budgetMs?: number, now?: () => number }} [opts]
 * @returns {Promise<{ verdict: Verdict, detail: string }>}
 */
async function probePublicRoots(targets, { budgetMs = PROBE_BUDGET_MS, now = Date.now } = {}) {
    const deadline = now() + budgetMs;
    for (;;) {
        const result = await probe(targets, []);
        if (result.verdict !== 'unreachable' || now() >= deadline) return result;
        log(`Nextcloud not reachable yet (${result.detail}) — retrying the certificate check in ${PROBE_RETRY_DELAY_MS / 1000}s`);
        await sleep(Math.min(PROBE_RETRY_DELAY_MS, Math.max(0, deadline - now())));
    }
}

/**
 * HTTPS Nextcloud targets to probe (NEXTCLOUD_URL + a distinct public URL).
 * @typedef {{ key: string, host: string, port: number, servername: string }} TlsTarget
 * @returns {TlsTarget[]}
 */
function httpsTargets() {
    /** @type {TlsTarget[]} */
    const targets = [];
    for (const raw of [process.env.NEXTCLOUD_URL, process.env.BEEFLOW_NC_PUBLIC_URL]) {
        if (!raw) continue;
        /** @type {URL} */
        let u;
        try { u = new URL(raw); } catch { continue; }
        if (u.protocol !== 'https:') continue; // plain HTTP → no TLS to decide
        const key = `${u.hostname}:${u.port || 443}`;
        if (!targets.some((t) => t.key === key)) {
            targets.push({ key, host: u.hostname, port: Number(u.port) || 443, servername: u.hostname });
        }
    }
    return targets;
}

/**
 * Resolve the posture: {} | {caCert} | {insecure:true}.
 * @param {{ budgetMs?: number, now?: () => number }} [opts]  probe retry budget (tests)
 * @returns {Promise<{ caCert?: string, insecure?: boolean }>}
 */
async function decide(opts = {}) {
    const targets = httpsTargets();
    if (!targets.length) return {};

    // 1. Admin-supplied CA: honour it as an explicit pin (secure; fails loudly
    //    if wrong rather than silently relaxing).
    const explicit = (process.env.BEEFLOW_NC_CA_CERT || '').trim();
    if (explicit) {
        log('using admin-supplied BEEFLOW_NC_CA_CERT as the Nextcloud trust anchor');
        return { caCert: explicit };
    }

    // 2. Already trusted by Node's bundled roots? (valid public / Let's Encrypt
    //    cert — the production and real-AIO case.) Leave verification strict.
    const publicRoots = await probePublicRoots(targets, opts);
    if (publicRoots.verdict === 'trusted') {
        log('Nextcloud certificate verifies against public roots — no override');
        return {};
    }
    // Could not reach Nextcloud at all: nothing is known about its certificate,
    // so nothing is relaxed. The connector retries its Nextcloud calls by
    // itself once Nextcloud is up; a genuinely self-signed Nextcloud that was
    // down for longer than the budget needs a restart of this app (or
    // BEEFLOW_NC_CA_CERT) to pick up the relaxed posture.
    if (publicRoots.verdict === 'unreachable') {
        log(`Nextcloud could not be reached for the certificate check (${publicRoots.detail}) — `
            + 'keeping strict verification; nothing is pinned or relaxed on a connection failure');
        return {};
    }
    log(`Nextcloud certificate does not verify against public roots (${publicRoots.detail})`);

    // 3. A HaRP / OS-mounted CA that makes it verify is the SECURE path —
    //    prefer pinning that over relaxing verification.
    const mounted = mountedCaPems();
    if (mounted.length && await verifiesWith(targets, mounted)) {
        log('Nextcloud certificate verifies against a mounted CA — pinning it');
        return { caCert: mounted.join('\n') };
    }

    // 4. Genuinely self-signed / internal cert with no usable CA → scoped relax,
    //    unless the operator opted out.
    const pin = (process.env.BEEFLOW_NC_TLS_PIN || 'auto').trim().toLowerCase();
    if (pin === 'off') {
        log('Nextcloud cert untrusted but BEEFLOW_NC_TLS_PIN=off — leaving verification strict (NC calls will fail until a valid cert or BEEFLOW_NC_CA_CERT is provided)');
        return {};
    }
    log('Nextcloud uses a self-signed / internal certificate with no trusted CA');
    return { insecure: true };
}

async function main() {
    const persistent = process.env.APP_PERSISTENT_STORAGE || '/data';
    let outDir = path.join(persistent, 'nc-trust');
    try {
        fs.mkdirSync(outDir, { recursive: true });
    } catch {
        outDir = '/tmp/nc-trust';
        try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* helper is best-effort */ }
    }
    const envPath = path.join(outDir, 'env');
    const caPath = path.join(outDir, 'nc-ca.pem');

    // Stale-run hygiene: clear previous output so a now-valid cert doesn't keep
    // an obsolete override around.
    try { fs.rmSync(envPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(caPath, { force: true }); } catch { /* ignore */ }

    const d = await decide();
    /** @type {string[]} */
    const lines = [];
    if (d.caCert) {
        fs.writeFileSync(caPath, d.caCert.endsWith('\n') ? d.caCert : d.caCert + '\n', { mode: 0o600 });
        lines.push(`BEEFLOW_NC_CA_FILE=${caPath}`);
        log(`pinning explicit Nextcloud CA → ${caPath}`);
    } else if (d.insecure) {
        lines.push('BEEFLOW_NC_TLS_INSECURE=1');
        log('Nextcloud uses an untrusted certificate — enabling scoped trust for the Nextcloud origin only (Bee Flow server + all other TLS stay verified)');
    } else {
        log('no TLS override needed');
    }
    if (lines.length) fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

// Run only when invoked directly; exporting helpers keeps them unit-testable.
if (require.main === module) {
    main().catch((err) => {
        log(`non-fatal error: ${err instanceof Error && err.message ? err.message : err}`);
        process.exit(0); // never block connector boot
    });
}

module.exports = { handshake, httpsTargets, decide, mountedCaPems, verifiesWith, probe, isCertError, CERT_ERROR_CODES };
