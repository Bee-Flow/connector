// HTTPS_PROXY and NO_PROXY: an outbound proxy for the connection to the Bee
// Flow server.
//
//   - the Bee Flow origin goes through the proxy (a CONNECT tunnel), for Node's
//     fetch and for the API proxy, an event stream included, and its
//     certificate is verified through the tunnel;
//   - the Nextcloud origin never does, whatever NO_PROXY says;
//   - NO_PROXY names hosts that are reached directly;
//   - the credentials of the proxy URL reach the proxy and no log line;
//   - without the value nothing goes through a proxy.
//
// The values are read when the modules load, so every combination runs in a
// child process (support/egressRunner.js) against a real CONNECT proxy and
// real TLS listeners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { installValues } = require('./support/installValues');
const { standIn: handler, listeners, runEgress } = require('./support/egressHarness');

installValues({ apiBaseUrl: 'http://beeflow.test' });

const { certFactory } = require('./support/certs');
const { parseProxyUrl, describeProxy, agentSupportsProxy } = require('../src/serverProxy');

const PASSWORD = 'pr0xy-s3cret-value';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-server-proxy-'));
const certs = certFactory(work);
const companyCa = certs.make({ isCa: true, cn: 'Company CA' });
const beeflowCert = certs.make({ ca: companyCa });
const nextcloudCert = certs.make({ ca: companyCa });

const { listen, closeAll } = listeners();

// The forward proxy: records every tunnel it is asked for.
/** @type {{ target: string, authorization: string | null }[]} */
const tunnels = [];
/** @type {string[]} */
const plainRequests = [];
function forwardProxy() {
    const proxy = http.createServer((req, res) => {
        plainRequests.push(req.url);
        res.statusCode = 400;
        res.end();
    });
    proxy.on('connect', (req, client, head) => {
        tunnels.push({ target: req.url, authorization: req.headers['proxy-authorization'] || null });
        const [host, port] = req.url.split(':');
        const upstream = net.connect(Number(port), host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    return proxy;
}

const url = {};
const port = {};
test.before(async () => {
    port.beeflow = await listen(https.createServer({ key: beeflowCert.key, cert: beeflowCert.cert }, handler));
    port.nextcloud = await listen(https.createServer({ key: nextcloudCert.key, cert: nextcloudCert.cert }, handler));
    port.proxy = await listen(forwardProxy());
    url.beeflow = `https://localhost:${port.beeflow}`;
    url.nextcloud = `https://localhost:${port.nextcloud}`;
    url.proxy = `http://connector:${PASSWORD}@127.0.0.1:${port.proxy}`;
});

test.after(async () => {
    await closeAll();
    fs.rmSync(work, { recursive: true, force: true });
});

test.beforeEach(() => { tunnels.length = 0; plainRequests.length = 0; });

/** Run the connector's clients in a process of their own with these install-time values. */
const run = (env, targets) => runEgress(env, targets, ['NODE_USE_ENV_PROXY', 'BEEFLOW_SERVER_CA_CERT', 'RUNNER_PROXY_NEXTCLOUD']);

// A Nextcloud and a Bee Flow server that both carry a certificate of the
// company CA: Nextcloud is trusted through its own setting, the Bee Flow server
// through BEEFLOW_SERVER_CA_CERT.
const base = () => ({
    NEXTCLOUD_URL: url.nextcloud,
    BEEFLOW_NC_CA_FILE: companyCa.certPath,
    BEEFLOW_API_BASE_URL: url.beeflow,
    BEEFLOW_SERVER_CA_CERT: companyCa.cert,
    BEEFLOW_TENANT_KEY: 'tenant-key',
});
const targets = () => ({ beeflow: url.beeflow, nextcloud: url.nextcloud, stream: url.beeflow });
const toBeeflow = () => `localhost:${port.beeflow}`;
const toNextcloud = () => `localhost:${port.nextcloud}`;

test('the Bee Flow origin goes through the proxy, the Nextcloud origin does not', async () => {
    const r = await run({ ...base(), HTTPS_PROXY: url.proxy }, targets());
    assert.equal(r.crashed, undefined, r.crashed);

    assert.equal(r.fetch.beeflow.ok, true, JSON.stringify(r.fetch.beeflow));
    assert.equal(r.proxy.beeflow.status, 200);
    assert.equal(r.fetch.nextcloud.ok, true, JSON.stringify(r.fetch.nextcloud));

    // Every tunnel is one to the Bee Flow server: fetch opened one, the API
    // proxy at least one. None to Nextcloud, and nothing in plain.
    assert.ok(tunnels.length >= 2, JSON.stringify(tunnels));
    assert.deepEqual([...new Set(tunnels.map((t) => t.target))], [toBeeflow()]);
    assert.ok(!tunnels.some((t) => t.target === toNextcloud()));
    assert.deepEqual(plainRequests, []);

    // The stream arrives through the tunnel as it is sent.
    assert.equal(r.stream.status, 200);
    assert.equal(r.stream.body, 'data: one\n\ndata: two\n\n');
    assert.equal(r.stream.pieces.length, 2);
    assert.ok(r.stream.pieces[1].at - r.stream.pieces[0].at >= 200, JSON.stringify(r.stream.pieces));
});

test('the credentials of the proxy URL reach the proxy and no log line', async () => {
    const r = await run({ ...base(), HTTPS_PROXY: url.proxy }, targets());
    const expected = `Basic ${Buffer.from(`connector:${PASSWORD}`).toString('base64')}`;
    assert.ok(tunnels.length > 0);
    for (const t of tunnels) assert.equal(t.authorization, expected);
    assert.ok(!r.log.includes(PASSWORD), 'the password is in no log line');
    assert.ok(!r.log.includes(expected.slice(6)), 'nor in its encoded form');
    assert.match(r.log, new RegExp(`go through the proxy http://127\\.0\\.0\\.1:${port.proxy};? `));
    assert.match(r.log, /Nextcloud is always reached directly/);
});

test('the certificate of the Bee Flow server is verified through the tunnel', async () => {
    const env = { ...base(), HTTPS_PROXY: url.proxy };
    delete env.BEEFLOW_SERVER_CA_CERT;
    const r = await run(env, { beeflow: url.beeflow });
    assert.ok(tunnels.length > 0, 'the proxy was used');
    assert.equal(r.fetch.beeflow.ok, false);
    assert.equal(r.fetch.beeflow.certificate, true, JSON.stringify(r.fetch.beeflow));
    assert.equal(r.proxy.beeflow.status, 502);
    assert.equal(JSON.parse(r.proxy.beeflow.body).code, 'saas_cert_untrusted');
});

test('Nextcloud is reached directly in its default posture too, and when a Bee Flow server shares its address', async () => {
    // No setting of its own for Nextcloud: the request is not tunnelled, it
    // reaches Nextcloud itself and is refused there on the certificate.
    const env = { ...base(), HTTPS_PROXY: url.proxy, RUNNER_PROXY_NEXTCLOUD: '1' };
    delete env.BEEFLOW_NC_CA_FILE;
    const r = await run(env, { nextcloud: url.nextcloud });
    assert.equal(r.fetch.nextcloud.ok, false);
    assert.equal(r.fetch.nextcloud.certificate, true, JSON.stringify(r.fetch.nextcloud));
    // The API proxy with a target on the Nextcloud origin: direct as well, and
    // without the extra certificate.
    assert.equal(r.proxy.nextcloud.status, 502);
    assert.deepEqual(tunnels, []);
    assert.deepEqual(plainRequests, []);
});

test('when the proxy is down the Bee Flow server is not reached around it, and Nextcloud still is', async () => {
    const dead = `http://connector:${PASSWORD}@127.0.0.1:1`;
    const r = await run({ ...base(), HTTPS_PROXY: dead }, { beeflow: url.beeflow, nextcloud: url.nextcloud });
    assert.equal(r.fetch.beeflow.ok, false);
    assert.equal(r.fetch.beeflow.certificate, false);
    assert.equal(r.fetch.beeflow.category, 'saas_unreachable');
    assert.equal(r.proxy.beeflow.status, 502);
    assert.equal(r.fetch.nextcloud.ok, true);
    assert.ok(!r.log.includes(PASSWORD), 'a failed connection does not log the password either');
});

test('NO_PROXY names hosts that are reached directly', async () => {
    const r = await run({ ...base(), HTTPS_PROXY: url.proxy, NO_PROXY: 'localhost,example.org' }, targets());
    assert.equal(r.fetch.beeflow.ok, true);
    assert.equal(r.proxy.beeflow.status, 200);
    assert.equal(r.stream.body, 'data: one\n\ndata: two\n\n');
    assert.deepEqual(tunnels, []);

    // NO_PROXY for another host changes nothing for Nextcloud: still direct.
    const other = await run({ ...base(), HTTPS_PROXY: url.proxy, NO_PROXY: 'example.org' }, targets());
    assert.equal(other.fetch.nextcloud.ok, true);
    assert.deepEqual([...new Set(tunnels.map((t) => t.target))], [toBeeflow()]);
});

test('without the value, or with one that is not a proxy URL, nothing goes through a proxy', async () => {
    const results = await Promise.all([
        run(base(), targets()),
        run({ ...base(), HTTPS_PROXY: '  ' }, targets()),
        run({ ...base(), HTTPS_PROXY: `socks5://connector:${PASSWORD}@127.0.0.1:${port.proxy}` }, targets()),
        run({ ...base(), HTTPS_PROXY: `//connector:${PASSWORD}@127.0.0.1:${port.proxy}` }, targets()),
        // NO_PROXY alone is not read.
        run({ ...base(), NO_PROXY: '*' }, targets()),
    ]);
    for (const r of results) {
        assert.equal(r.fetch.beeflow.ok, true);
        assert.equal(r.proxy.beeflow.status, 200);
        assert.equal(r.stream.pieces.length, 2);
        assert.ok(!r.log.includes(PASSWORD), 'an unusable value is not logged');
    }
    assert.match(results[2].log, /HTTPS_PROXY must be an http:\/\/ or https:\/\/ URL; it is ignored/);
    assert.match(results[3].log, /HTTPS_PROXY is not a URL; it is ignored/);
    assert.deepEqual(tunnels, []);
    assert.deepEqual(plainRequests, []);
});

test('reading the value', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    assert.equal(parseProxyUrl('', { warn }), null);
    assert.equal(parseProxyUrl(undefined, { warn }), null);
    assert.equal(warnings.length, 0);
    const parsed = parseProxyUrl(' http://user:secret@proxy.example.com:3128 ', { warn });
    assert.equal(describeProxy(parsed), 'http://proxy.example.com:3128');
    assert.equal(describeProxy(parseProxyUrl('https://proxy.example.com', { warn })), 'https://proxy.example.com');
    assert.equal(parseProxyUrl('ftp://user:secret@proxy.example.com', { warn }), null);
    assert.equal(parseProxyUrl('user:secret@proxy', { warn }), null);
    assert.equal(warnings.length, 2);
    for (const w of warnings) assert.ok(!w.includes('secret'));

    assert.equal(agentSupportsProxy('22.21.0'), true);
    assert.equal(agentSupportsProxy('22.23.4'), true);
    assert.equal(agentSupportsProxy('24.0.0'), true);
    assert.equal(agentSupportsProxy('22.15.0'), false);
    assert.equal(agentSupportsProxy(process.versions.node), true, 'the Node this suite runs on');
});

test('info.xml declares both values without a default', () => {
    const infoXml = fs.readFileSync(path.join(__dirname, '..', 'appinfo', 'info.xml'), 'utf8');
    for (const name of ['HTTPS_PROXY', 'NO_PROXY']) {
        const block = new RegExp(`<variable>\\s*<name>${name}</name>[\\s\\S]*?</variable>`).exec(infoXml);
        assert.ok(block, `${name} is declared`);
        assert.doesNotMatch(block[0], /<default/, name);
    }
});
