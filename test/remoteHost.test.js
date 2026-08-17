// Remote-host validation — the ExApp stand-in for IRemoteHostValidator
// (developer_manual/digging_deeper/security.html).
//
// The line these pin: link-local and cloud-metadata addresses are refused,
// loopback and RFC1918 are NOT — self-hosting against `http://bee-flow-server:3001`
// is a supported deployment of this product, and a validator that broke it would
// be protecting nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAllowedUrl, assertAllowedUrl, isBlockedAddress, RemoteHostError } = require('../src/remoteHost');

function refuses(url, expectedCode) {
    assert.throws(() => parseAllowedUrl(url, { label: 'test' }), (err) => {
        assert.ok(err instanceof RemoteHostError, `expected RemoteHostError, got ${err}`);
        if (expectedCode) assert.equal(err.code, expectedCode);
        return true;
    }, `${url} should have been refused`);
}

test('only http and https are accepted', () => {
    refuses('file:///etc/passwd', 'bad_scheme');
    refuses('gopher://example.com/', 'bad_scheme');
    refuses('ftp://example.com/', 'bad_scheme');
    assert.equal(parseAllowedUrl('http://example.com').protocol, 'http:');
    assert.equal(parseAllowedUrl('https://example.com').protocol, 'https:');
});

test('credentials in the URL are refused — they would end up in logs and callbacks', () => {
    refuses('https://user:pass@example.com/', 'credentials_in_url');
});

test('the cloud metadata endpoint is refused, by IP and by name', () => {
    refuses('http://169.254.169.254/latest/meta-data/', 'blocked_host');
    refuses('http://169.254.1.1/', 'blocked_host');
    refuses('http://metadata.google.internal/', 'blocked_host');
    refuses('http://100.100.100.200/', 'blocked_host');
});

test('IPv6 link-local and the v4-mapped spelling of metadata are refused', () => {
    assert.equal(isBlockedAddress('fe80::1'), true);
    assert.equal(isBlockedAddress('fd00:ec2::254'), true);
    assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
});

test('loopback and private addresses stay allowed — self-hosting depends on them', () => {
    for (const url of [
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://bee-flow-server:3001',
        'http://192.168.1.10:3001',
        'http://10.0.0.5:3001',
        'https://bee-flow.internal.example',
    ]) {
        assert.doesNotThrow(() => parseAllowedUrl(url, { label: 'test' }), `${url} must stay allowed`);
    }
});

test('garbage and empty input are rejected before anything connects', () => {
    refuses('', 'missing_url');
    refuses('not a url', 'malformed_url');
    refuses('https://', 'malformed_url');
});

test('a literal blocked IP is caught without a DNS round-trip', async () => {
    await assert.rejects(
        () => assertAllowedUrl('http://169.254.169.254/', { label: 'test' }),
        (err) => err.code === 'blocked_host');
});

test('an unresolvable host is not treated as a security failure', async () => {
    // It is an unreachable server; the caller reports that far more usefully
    // than a validator can, so validation abstains.
    const url = await assertAllowedUrl('https://does-not-exist.invalid/', { label: 'test' });
    assert.equal(url.hostname, 'does-not-exist.invalid');
});
