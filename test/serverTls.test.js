// BEEFLOW_SERVER_CA_CERT: the certificate a self-hosted Bee Flow server may
// carry from a company certificate authority.
//
//   - with the value, a Bee Flow server with such a certificate works, for
//     Node's fetch and for the API proxy (an event stream included);
//   - without it, that server is refused, and the refusal has its own category;
//   - the value ADDS to the default roots: a self-signed peer that is not in it
//     is still refused, and there is no value that switches verification off;
//   - it never applies to a Nextcloud origin;
//   - left empty, nothing changes: no dispatcher, no agent option, and an event
//     stream passes the proxy piece by piece as before.
//
// The values are read when the modules load, so every combination runs in a
// child process (support/egressRunner.js) against real TLS listeners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { installValues } = require('./support/installValues');
const { standIn: handler, listeners, runEgress } = require('./support/egressHarness');

installValues({ apiBaseUrl: 'http://beeflow.test' });

const { certFactory } = require('./support/certs');
const { readExtraCertificates, pemBlocks, rootsWith } = require('../src/serverTls');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-server-tls-'));
const certs = certFactory(work);
const companyCa = certs.make({ isCa: true, cn: 'Company CA' });
const beeflowCert = certs.make({ ca: companyCa });
const nextcloudCert = certs.make({ ca: companyCa });
const selfSigned = certs.make();
const otherCa = certs.make({ isCa: true, cn: 'Another CA' });

const { listen, closeAll } = listeners();

const url = {};
test.before(async () => {
    url.beeflow = `https://localhost:${await listen(https.createServer({ key: beeflowCert.key, cert: beeflowCert.cert }, handler))}`;
    url.nextcloud = `https://localhost:${await listen(https.createServer({ key: nextcloudCert.key, cert: nextcloudCert.cert }, handler))}`;
    url.selfSigned = `https://localhost:${await listen(https.createServer({ key: selfSigned.key, cert: selfSigned.cert }, handler))}`;
    url.plain = `http://127.0.0.1:${await listen(http.createServer(handler))}`;
});

test.after(async () => {
    await closeAll();
    fs.rmSync(work, { recursive: true, force: true });
});

/** Run the connector's clients in a process of their own with these install-time values. */
const run = (env, targets) => runEgress(env, targets);

const base = () => ({ NEXTCLOUD_URL: url.nextcloud, BEEFLOW_API_BASE_URL: url.beeflow, BEEFLOW_TENANT_KEY: 'tenant-key' });
const everyTarget = () => ({ beeflow: url.beeflow, nextcloud: url.nextcloud, selfSigned: url.selfSigned, stream: url.beeflow });

test('with the certificate of the company CA the Bee Flow server works, for fetch, the proxy and a stream', async () => {
    const r = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: companyCa.cert }, everyTarget());
    assert.equal(r.crashed, undefined, r.crashed);
    assert.equal(r.extraCertificates, true);
    assert.deepEqual(r.fetch.beeflow, { ok: true, status: 200, body: JSON.stringify({ status: 'ok', path: '/api/health' }) });
    assert.equal(r.proxy.beeflow.status, 200);
    assert.equal(JSON.parse(r.proxy.beeflow.body).status, 'ok');

    // The stream arrives as it is sent: two pieces, the second well after the first.
    assert.equal(r.stream.status, 200);
    assert.match(r.stream.contentType, /^text\/event-stream/);
    assert.equal(r.stream.body, 'data: one\n\ndata: two\n\n');
    assert.equal(r.stream.pieces.length, 2);
    assert.ok(r.stream.pieces[1].at - r.stream.pieces[0].at >= 200, JSON.stringify(r.stream.pieces));
});

test('the value may also be the path of a PEM file, or a PEM pasted on one line', async () => {
    const byPath = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: companyCa.certPath }, { beeflow: url.beeflow });
    assert.equal(byPath.fetch.beeflow.ok, true);
    assert.equal(byPath.proxy.beeflow.status, 200);

    const oneLine = companyCa.cert.trim().replace(/\n/g, ' ');
    const pasted = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: oneLine }, { beeflow: url.beeflow });
    assert.equal(pasted.fetch.beeflow.ok, true);
    assert.equal(pasted.proxy.beeflow.status, 200);
});

test('without the value that server is refused, under a category of its own', async () => {
    const r = await run(base(), { beeflow: url.beeflow });
    assert.equal(r.extraCertificates, false);
    assert.equal(r.fetch.beeflow.ok, false);
    assert.equal(r.fetch.beeflow.certificate, true, JSON.stringify(r.fetch.beeflow));
    assert.equal(r.fetch.beeflow.category, 'saas_cert_untrusted');
    assert.equal(r.proxy.beeflow.status, 502);
    assert.equal(JSON.parse(r.proxy.beeflow.body).code, 'saas_cert_untrusted');
    assert.match(r.log, /certificate of the Bee Flow server is not trusted; see BEEFLOW_SERVER_CA_CERT/);
});

test('a self-signed peer that is not in the value is still refused', async () => {
    const r = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: companyCa.cert }, { selfSigned: url.selfSigned });
    assert.equal(r.fetch.selfSigned.ok, false);
    assert.equal(r.fetch.selfSigned.certificate, true);
    assert.ok(r.fetch.selfSigned.codes.includes('DEPTH_ZERO_SELF_SIGNED_CERT'), JSON.stringify(r.fetch.selfSigned));
    assert.equal(r.proxy.selfSigned.status, 502);
    assert.equal(JSON.parse(r.proxy.selfSigned.body).code, 'saas_cert_untrusted');

    // Another authority's certificate does not help either.
    const wrong = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: otherCa.cert }, { beeflow: url.beeflow });
    assert.equal(wrong.fetch.beeflow.ok, false);
    assert.equal(wrong.proxy.beeflow.status, 502);
});

test('a self-signed Bee Flow server works once its own certificate is the value', async () => {
    const r = await run({ ...base(), BEEFLOW_API_BASE_URL: url.selfSigned, BEEFLOW_SERVER_CA_CERT: selfSigned.cert },
        { selfSigned: url.selfSigned, beeflow: url.beeflow });
    assert.equal(r.fetch.selfSigned.ok, true);
    assert.equal(r.proxy.selfSigned.status, 200);
    assert.equal(r.fetch.beeflow.ok, false, 'and only that certificate');
});

test('the value never applies to a Nextcloud origin', async () => {
    // Nextcloud's certificate is from the same company CA. The value is for the
    // Bee Flow server: the Nextcloud origin keeps the posture it had.
    const r = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: companyCa.cert }, { beeflow: url.beeflow, nextcloud: url.nextcloud });
    assert.equal(r.fetch.beeflow.ok, true);
    assert.equal(r.fetch.nextcloud.ok, false);
    assert.equal(r.fetch.nextcloud.certificate, true);

    // And with a public Nextcloud address next to the internal one.
    const both = await run({
        ...base(), NEXTCLOUD_URL: 'http://nc.internal', BEEFLOW_NC_PUBLIC_URL: url.nextcloud,
        BEEFLOW_SERVER_CA_CERT: companyCa.cert,
    }, { nextcloud: url.nextcloud });
    assert.equal(both.fetch.nextcloud.ok, false);
});

test('no value switches verification off', async () => {
    await Promise.all(['off', 'false', '0', 'none', 'insecure', '*'].map(async (value) => {
        const r = await run({ ...base(), BEEFLOW_SERVER_CA_CERT: value }, { beeflow: url.beeflow });
        assert.equal(r.extraCertificates, false, value);
        assert.equal(r.fetch.beeflow.ok, false, value);
        assert.equal(r.proxy.beeflow.status, 502, value);
    }));
});

test('left empty nothing changes: no dispatcher, no agent option, and a stream passes piece by piece', async () => {
    await Promise.all([undefined, '', '   '].map(async (value) => {
        const env = { ...base(), NEXTCLOUD_URL: 'http://nc.test', BEEFLOW_API_BASE_URL: url.plain };
        if (value !== undefined) env.BEEFLOW_SERVER_CA_CERT = value;
        const r = await run(env, { plain: url.plain, stream: url.plain });
        assert.equal(r.extraCertificates, false);
        assert.deepEqual(r.httpsAgentOptions, []);
        assert.equal(r.dispatcherReplaced, false);
        assert.equal(r.fetch.plain.ok, true);
        assert.equal(r.proxy.plain.status, 200);
        assert.equal(r.stream.body, 'data: one\n\ndata: two\n\n');
        assert.equal(r.stream.pieces.length, 2);
        assert.ok(r.stream.pieces[1].at - r.stream.pieces[0].at >= 200, JSON.stringify(r.stream.pieces));
    }));
});

test('reading the value: PEM text, a chain, a path, and what is ignored', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    assert.deepEqual(readExtraCertificates('', { warn }), []);
    assert.deepEqual(readExtraCertificates(undefined, { warn }), []);
    assert.equal(warnings.length, 0);

    assert.equal(readExtraCertificates(companyCa.cert, { warn }).length, 1);
    assert.equal(readExtraCertificates(`${companyCa.cert}\n${otherCa.cert}`, { warn }).length, 2, 'a chain');
    assert.equal(readExtraCertificates(companyCa.certPath, { warn }).length, 1);
    assert.equal(readExtraCertificates(companyCa.cert.replace(/\n/g, '\\n'), { warn }).length, 1, 'escaped line breaks');
    assert.equal(warnings.length, 0);

    assert.deepEqual(readExtraCertificates('/no/such/file.pem', { warn }), []);
    assert.match(warnings.pop(), /BEEFLOW_SERVER_CA_CERT is neither PEM text nor a readable file/);
    assert.deepEqual(readExtraCertificates('-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----', { warn }), []);
    assert.ok(warnings.some((m) => /cannot be read/.test(m)));
    // A private key is not a certificate and is never kept.
    assert.deepEqual(readExtraCertificates(companyCa.key, { warn }), []);

    assert.equal(pemBlocks(companyCa.cert)[0].trim(), companyCa.cert.trim());
});

test('the roots are the default ones plus the extra certificate', () => {
    const tls = require('node:tls');
    const roots = rootsWith([companyCa.cert]);
    assert.equal(roots.length, tls.getCACertificates('default').length + 1);
    assert.ok(roots.length > 50, 'the public roots are still there');
    assert.equal(roots.at(-1), companyCa.cert);
});

test('info.xml declares the value without a default, and the failure texts name it', () => {
    const infoXml = fs.readFileSync(path.join(__dirname, '..', 'appinfo', 'info.xml'), 'utf8');
    const block = /<variable>\s*<name>BEEFLOW_SERVER_CA_CERT<\/name>[\s\S]*?<\/variable>/.exec(infoXml);
    assert.ok(block, 'declared');
    assert.doesNotMatch(block[0], /<default/);

    const { remediationFor, categoriseError } = require('../src/bootstrap');
    assert.match(remediationFor('saas_cert_untrusted'), /BEEFLOW_SERVER_CA_CERT/);
    assert.match(remediationFor('saas_cert_untrusted'), /cannot be switched off/);
    const { CONNECT_ERRORS, CATEGORY_TO_CONNECT_ERROR } = require('../src/setupTexts');
    assert.equal(CATEGORY_TO_CONNECT_ERROR.saas_cert_untrusted, 'certificate_not_trusted');
    assert.match(CONNECT_ERRORS.certificate_not_trusted, /BEEFLOW_SERVER_CA_CERT/);

    // fetch hides the TLS failure as the cause of "fetch failed".
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
    assert.equal(categoriseError(refused, 'saas_post'), 'saas_cert_untrusted');
    assert.equal(categoriseError(new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }), 'saas_post'), 'saas_unreachable');
    // A certificate failure while asking Nextcloud is about Nextcloud's certificate, not the server's.
    assert.equal(categoriseError(refused, 'capabilities'), 'nc_cert_untrusted');
});
