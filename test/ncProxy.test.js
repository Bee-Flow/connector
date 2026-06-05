// verifyHmac must be tolerant of the NC/HaRP proxy percent-decoding the URL
// path (e.g. `%40` → `@`) before it reaches the connector. The SaaS signs the
// callback HMAC over the DECODED path; the connector verifies against the
// decoded path and still accepts the raw path (older SaaS) during rollout.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { verifyHmac } = require('../src/ncProxy');
const config = require('../src/config');

function sign(ts, signedMethod, path, ncUid) {
    return crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${signedMethod}\n${path}\n${ncUid}`).digest('hex');
}

// A request as the connector sees it after the proxy: wire method (POST for
// tunnelled verbs), the X-HTTP-Method-Override, the (possibly decoded)
// originalUrl, and the SaaS signature header.
function reqFor({ originalUrl, wireMethod = 'POST', override, ncUid = 'alice', ts, sig }) {
    const headers = { 'x-beeflow-sig': `${ts}.${sig}`, 'x-beeflow-nc-uid': ncUid };
    if (override) headers['x-http-method-override'] = override;
    return { method: wireMethod, originalUrl, headers };
}

const now = () => Math.floor(Date.now() / 1000);
// Calendar event create: path carries `@` (event UID `…@host`); also covers
// email-named calendars (`tomkooy@beeflow.nl`).
const DECODED = '/nc/remote.php/dav/calendars/alice/personal/9b2-uid@nc.test.ics';
const ENCODED = '/nc/remote.php/dav/calendars/alice/personal/9b2-uid%40nc.test.ics';

test('SaaS signs decoded path; proxy DECODES it (%40→@) — accepted', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', DECODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: DECODED, override: 'PUT', ts, sig })), true);
});

test('SaaS signs decoded path; proxy PRESERVES encoding (%40) — accepted', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', DECODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: ENCODED, override: 'PUT', ts, sig })), true);
});

test('plain read path (no escapes) verifies', () => {
    const ts = now();
    const path = '/nc/remote.php/dav/calendars/alice/';
    const sig = sign(ts, 'PROPFIND', path, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: path, override: 'PROPFIND', ts, sig })), true);
});

test('backward-compat: older SaaS signs raw %40 path, proxy preserves — accepted', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', ENCODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: ENCODED, override: 'PUT', ts, sig })), true);
});

test('tampered method (override swapped) is rejected', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', DECODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: DECODED, override: 'DELETE', ts, sig })), false);
});

test('tampered path is rejected', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', DECODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: '/nc/remote.php/dav/calendars/alice/personal/evil.ics', override: 'PUT', ts, sig })), false);
});

test('expired timestamp is rejected', () => {
    const ts = now() - 100000;
    const sig = sign(ts, 'PUT', DECODED, 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: DECODED, override: 'PUT', ts, sig })), false);
});

test('missing signature header is rejected', () => {
    assert.equal(verifyHmac({ method: 'POST', originalUrl: DECODED, headers: { 'x-beeflow-nc-uid': 'alice' } }), false);
});
