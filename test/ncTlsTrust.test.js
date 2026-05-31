const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { httpsTargets, decide, verifiesWith } = require('../src/ncTlsTrust');

function withEnv(overrides, fn) {
    const prev = { ...process.env };
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => { process.env = prev; });
}

test('httpsTargets parses https NC URLs, skips http, de-dupes', () => {
    return withEnv({ NEXTCLOUD_URL: 'https://nc.example:8443/', BEEFLOW_NC_PUBLIC_URL: 'https://nc.example:8443' }, () => {
        const t = httpsTargets();
        assert.equal(t.length, 1);
        assert.equal(t[0].host, 'nc.example');
        assert.equal(t[0].port, 8443);
    });
});

test('httpsTargets ignores a plain-HTTP Nextcloud (nothing to decide)', () => {
    return withEnv({ NEXTCLOUD_URL: 'http://nc.internal', BEEFLOW_NC_PUBLIC_URL: undefined }, () => {
        assert.equal(httpsTargets().length, 0);
    });
});

test('decide → {} when there is no HTTPS NC target', () => {
    return withEnv({ NEXTCLOUD_URL: 'http://nc.internal', BEEFLOW_NC_PUBLIC_URL: undefined, BEEFLOW_NC_CA_CERT: undefined }, async () => {
        assert.deepEqual(await decide(), {});
    });
});

test('decide → {caCert} when admin supplies BEEFLOW_NC_CA_CERT', () => {
    return withEnv({
        NEXTCLOUD_URL: 'https://nc.example',
        BEEFLOW_NC_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    }, async () => {
        const d = await decide();
        assert.match(d.caCert || '', /BEGIN CERTIFICATE/);
    });
});

test('against a self-signed Nextcloud: decide → insecure (auto), {} when PIN=off; cert pins via CA', async () => {
    const selfsigned = makeSelfSigned();
    const server = tls.createServer({ key: selfsigned.key, cert: selfsigned.cert }, (s) => s.end());
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    try {
        const base = { NEXTCLOUD_URL: `https://127.0.0.1:${port}`, BEEFLOW_NC_PUBLIC_URL: undefined, BEEFLOW_NC_CA_CERT: undefined };

        // Default roots do NOT trust it; trusting its own self-signed cert does.
        await withEnv(base, async () => {
            const targets = httpsTargets();
            assert.equal(await verifiesWith(targets, []), false);
            assert.equal(await verifiesWith(targets, [selfsigned.cert.toString()]), true);
        });

        // auto → scoped relax.
        await withEnv({ ...base, BEEFLOW_NC_TLS_PIN: 'auto' }, async () => {
            assert.deepEqual(await decide(), { insecure: true });
        });

        // off → stay strict (no override).
        await withEnv({ ...base, BEEFLOW_NC_TLS_PIN: 'off' }, async () => {
            assert.deepEqual(await decide(), {});
        });
    } finally {
        await new Promise((res) => server.close(res));
    }
});

// Generate a self-signed cert at test time so we don't ship key material.
function makeSelfSigned() {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tls-test-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}
