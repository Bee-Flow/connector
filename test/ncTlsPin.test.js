// #403: the self-signed TLS mode accepted ANY certificate for Nextcloud, so
// anyone who could intercept the connector's traffic to Nextcloud saw the
// AppAPI app secret on every call. Now the first certificate's key is pinned
// per host (trust on first use), both HTTP agents check it, a changed key is
// refused before anything is sent, and an admin accepts a renewal explicitly.
//
// One real TLS server per test, whose certificate is swapped in place
// (setSecureContext): the same host and port, two self-signed certificates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const undici = require('undici');
const { createPinStore, isPinMismatch } = require('../src/ncTlsPin');
const { pinnedHttpsAgent, pinnedConnector } = require('../src/ncTls');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-nc-pin-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
/** A self-signed certificate (or, with `ca`, one signed by that CA) for 127.0.0.1. */
function makeCert({ ca = null, isCa = false, cn = 'localhost' } = {}) {
    const id = ++n;
    const key = path.join(work, `k${id}.pem`);
    const cert = path.join(work, `c${id}.pem`);
    const ext = isCa ? ['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'] : ['-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'];
    if (!ca) {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
            '-subj', `/CN=${cn}`, ...ext, '-keyout', key, '-out', cert], { stdio: 'ignore' });
    } else {
        const csr = path.join(work, `r${id}.csr`);
        const extFile = path.join(work, `e${id}.cnf`);
        fs.writeFileSync(extFile, 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
        execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
            '-subj', `/CN=${cn}`, '-keyout', key, '-out', csr], { stdio: 'ignore' });
        execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca.certPath, '-CAkey', ca.keyPath, '-CAcreateserial',
            '-days', '1', '-extfile', extFile, '-out', cert], { stdio: 'ignore' });
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), keyPath: key, certPath: cert };
}

/** A TLS server that counts the requests that actually reached it. */
async function tlsServer(first) {
    const seen = [];
    const srv = https.createServer({ key: first.key, cert: first.cert }, (req, res) => {
        seen.push({ url: req.url, auth: req.headers['authorization-app-api'] || null });
        // A fresh connection per request, so the next one shows the current
        // certificate (an established, already checked connection is fine).
        res.setHeader('Connection', 'close');
        res.end('ok');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return {
        srv, seen,
        port: srv.address().port,
        /** Swap the certificate in place: same host, same port. */
        present: (c) => srv.setSecureContext({ key: c.key, cert: c.cert }),
    };
}

const quietLog = () => {
    const lines = [];
    return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) };
};

/** One request through the pinned https.Agent (the /nc/* reverse proxy's agent). */
function viaHttpsAgent(agent, port) {
    return new Promise((resolve) => {
        const req = https.request({
            host: '127.0.0.1', port, path: '/ocs', agent, rejectUnauthorized: false,
            headers: { 'AUTHORIZATION-APP-API': 'c2VjcmV0' },
        }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
        req.on('error', (err) => resolve({ err }));
        req.end();
    });
}

/** One request through the pinned undici Agent (every fetch to Nextcloud). */
async function viaUndici(dispatcher, port) {
    try {
        const res = await undici.fetch(`https://127.0.0.1:${port}/ocs`, { dispatcher, headers: { 'AUTHORIZATION-APP-API': 'c2VjcmV0' } });
        await res.text();
        return { status: res.status };
    } catch (err) {
        return { err };
    }
}

for (const [name, make, send] of [
    ['https.Agent', (store) => pinnedHttpsAgent({ keepAlive: false, rejectUnauthorized: false }, () => store), viaHttpsAgent],
    ['undici', (store) => new undici.Agent({ connect: pinnedConnector(undici, { rejectUnauthorized: false }, () => store) }), viaUndici],
]) {
    test(`${name}: pins the first self-signed certificate, refuses a second one before sending anything, then accepts it on request`, async (t) => {
        const certA = makeCert();
        const certB = makeCert();
        const server = await tlsServer(certA);
        t.after(() => server.srv.close());
        const log = quietLog();
        const file = path.join(work, `pins-${name}.json`);
        const store = createPinStore({ file, log });
        const agent = make(store);
        t.after(() => agent.destroy?.());

        // First use: pinned, and the request goes through.
        assert.equal((await send(agent, server.port)).status, 200);
        assert.equal((await send(agent, server.port)).status, 200);
        const hostKey = `127.0.0.1:${server.port}`;
        const pinnedA = store.snapshot().pins[hostKey].spki;
        assert.match(pinnedA, /^sha256\/[A-Za-z0-9+/]{43}=$/);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pins[hostKey].spki, pinnedA, 'the pin survives a restart');
        assert.equal(server.seen.length, 2);

        // Someone else's certificate on the same host and port: refused, and
        // not one request (so not one app secret) reached it.
        server.present(certB);
        const refused = await send(agent, server.port);
        assert.ok(refused.err, 'the connection is refused');
        assert.ok(isPinMismatch(refused.err), `a pin refusal, got: ${refused.err}`);
        assert.equal(server.seen.length, 2, 'nothing was sent over the refused connection');
        const pending = store.snapshot().pending[hostKey];
        assert.ok(pending && pending.spki !== pinnedA, 'the new key waits for an admin');
        assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('CHANGED') && m.includes(pending.spki)), 'the change is logged');

        // A stale or wrong confirmation accepts nothing.
        assert.deepEqual(store.accept(pinnedA), []);
        assert.ok(isPinMismatch((await send(agent, server.port)).err));

        // The admin accepts the key the log and the setup page named.
        assert.deepEqual(store.accept(pending.spki), [hostKey]);
        assert.equal((await send(agent, server.port)).status, 200);
        assert.equal(server.seen.length, 3);
        // ... and the old certificate is now the stranger.
        server.present(certA);
        assert.ok(isPinMismatch((await send(agent, server.port)).err));
    });
}

test('behind an internal CA that sends its certificate, a renewed leaf keeps working and a look-alike CA does not', async (t) => {
    const ca = makeCert({ isCa: true, cn: 'Internal CA' });
    const leaf1 = makeCert({ ca });
    const leaf2 = makeCert({ ca });
    // Same CA name, different key: what an interceptor would make up.
    const fakeCa = makeCert({ isCa: true, cn: 'Internal CA' });
    const fakeLeaf = makeCert({ ca: fakeCa });
    const chain = (leaf, issuer) => ({ key: leaf.key, cert: Buffer.concat([leaf.cert, issuer.cert]) });

    const server = await tlsServer(chain(leaf1, ca));
    t.after(() => server.srv.close());
    const store = createPinStore({ file: path.join(work, 'pins-ca.json'), log: quietLog() });
    const agent = pinnedHttpsAgent({ keepAlive: false, rejectUnauthorized: false }, () => store);

    assert.equal((await viaHttpsAgent(agent, server.port)).status, 200);
    server.present(chain(leaf2, ca));
    assert.equal((await viaHttpsAgent(agent, server.port)).status, 200, 'a renewed leaf under the pinned CA');
    server.present(chain(fakeLeaf, fakeCa));
    assert.ok(isPinMismatch((await viaHttpsAgent(agent, server.port)).err), 'a made-up CA with the same name');
    // A leaf of the real CA's name that the real CA did not sign, sent with the real CA certificate.
    server.present({ key: fakeLeaf.key, cert: Buffer.concat([fakeLeaf.cert, ca.cert]) });
    assert.ok(isPinMismatch((await viaHttpsAgent(agent, server.port)).err), 'the real CA certificate does not vouch for a leaf it did not sign');
});

test('an unreadable pin file refuses every connection instead of pinning afresh', async (t) => {
    const file = path.join(work, 'pins-corrupt.json');
    fs.writeFileSync(file, '{not json');
    const server = await tlsServer(makeCert());
    t.after(() => server.srv.close());
    const log = quietLog();
    const store = createPinStore({ file, log });
    const agent = pinnedHttpsAgent({ keepAlive: false, rejectUnauthorized: false }, () => store);
    assert.ok(isPinMismatch((await viaHttpsAgent(agent, server.port)).err));
    assert.equal(server.seen.length, 0);
    assert.ok(log.lines.some(([lvl]) => lvl === 'warn'));
});

// #453: the relaxed posture is also entered when Nextcloud was merely
// unreachable while the boot helper decided. A certificate the public roots
// trust is then never pinned, and it supersedes an older self-signed pin.
test('a certificate Node itself authorizes is accepted without a pin, also over a different recorded pin', () => {
    const log = quietLog();
    const file = path.join(work, 'pins-authorized.json');
    fs.writeFileSync(file, JSON.stringify({ pins: { 'nc.example:443': { spki: 'sha256/old-self-signed', since: '2026-01-01T00:00:00.000Z' } }, pending: {} }));
    const store = createPinStore({ file, log });
    const fakeChain = { raw: Buffer.from('not-read'), issuerCertificate: null };
    const socket = { authorized: true, getPeerCertificate: () => fakeChain };

    assert.equal(store.check('nc.example:443', socket), null, 'accepted');
    assert.equal(store.check('nc.fresh:443', socket), null, 'accepted for a host without a pin');
    const snap = store.snapshot();
    assert.equal(snap.pins['nc.fresh:443'], undefined, 'nothing pinned for a publicly valid certificate');
    assert.equal(snap.pins['nc.example:443'].spki, 'sha256/old-self-signed', 'the old pin is left alone, not rewritten');
    assert.deepEqual(snap.pending, {}, 'nothing pending');
    assert.equal(log.lines.filter(([, m]) => /not pinning/.test(m)).length, 2, 'one line per host');
    store.check('nc.example:443', socket);
    assert.equal(log.lines.filter(([, m]) => /not pinning/.test(m)).length, 2, 'logged once per host');
});
