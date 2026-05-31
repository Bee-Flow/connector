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
 *  3. If the strict handshake FAILS (self-signed / internal CA) and
 *     BEEFLOW_NC_TLS_PIN is not "off" → emit BEEFLOW_NC_TLS_INSECURE=1 so the
 *     connector trusts that Nextcloud origin. "off" leaves verification strict
 *     (for security-strict environments that prefer a hard failure).
 *
 * Never throws fatally: a failure here must not stop the connector booting.
 */

'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');

const HANDSHAKE_TIMEOUT_MS = 8000;

function log(msg) {
    process.stderr.write(`[nc-tls-trust] ${msg}\n`);
}

/**
 * One TLS handshake. Resolves { ok, authorized, error }.
 *  - strict=true → rejectUnauthorized:true; the secureConnect callback only
 *    fires when the certificate verifies, so ok && authorized ⇒ trusted.
 *  - caPems (optional) → trust these PEM CA(s) IN ADDITION to Node's bundled
 *    roots for this check (used to test an explicit / HaRP-mounted CA).
 */
function handshake(host, port, servername, strict, caPems) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        // SNI must be a hostname, never an IP literal (RFC 6066).
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(servername || '') || (servername || '').includes(':');
        const opts = { host, port, rejectUnauthorized: strict, timeout: HANDSHAKE_TIMEOUT_MS };
        if (servername && !isIp) opts.servername = servername;
        if (caPems && caPems.length) {
            // tls `ca` REPLACES the defaults, so include the bundled roots too.
            opts.ca = [].concat(tls.rootCertificates, caPems);
        }
        const socket = tls.connect(opts, () => {
            const authorized = socket.authorized;
            socket.end();
            done({ ok: true, authorized });
        });
        socket.on('error', (err) => done({ ok: false, error: err }));
        socket.on('timeout', () => { socket.destroy(); done({ ok: false, error: new Error('handshake timeout') }); });
    });
}

/** PEM CAs HaRP / AppAPI may mount when NC is reached over a non-public CA. */
function mountedCaPems() {
    const dir = '/usr/local/share/ca-certificates';
    const out = [];
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.crt')) continue;
            try { out.push(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip */ }
        }
    } catch { /* dir absent — normal */ }
    return out;
}

/** True when every target's certificate verifies with the given extra CAs. */
async function verifiesWith(targets, caPems) {
    for (const t of targets) {
        const s = await handshake(t.host, t.port, t.servername, true, caPems);
        if (!(s.ok && s.authorized)) return false;
    }
    return true;
}

/** HTTPS Nextcloud targets to probe (NEXTCLOUD_URL + a distinct public URL). */
function httpsTargets() {
    const targets = [];
    for (const raw of [process.env.NEXTCLOUD_URL, process.env.BEEFLOW_NC_PUBLIC_URL]) {
        if (!raw) continue;
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

/** Resolve the posture: {} | {caCert} | {insecure:true}. */
async function decide() {
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
    if (await verifiesWith(targets, [])) {
        log('Nextcloud certificate verifies against public roots — no override');
        return {};
    }

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
        log(`non-fatal error: ${err && err.message ? err.message : err}`);
        process.exit(0); // never block connector boot
    });
}

module.exports = { handshake, httpsTargets, decide, mountedCaPems, verifiesWith };
