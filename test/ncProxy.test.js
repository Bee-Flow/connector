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

// ── Body binding (added with the v2 signature) ──────────────────────────────
//
// The signature used to cover only (ts, method, path, ncUid). Because every
// write verb is tunnelled as POST + X-HTTP-Method-Override, that made an
// observed signature a five-minute licence to overwrite the same file with
// different content. v2 folds sha256(body) into the message.

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function signV2(ts, signedMethod, path, ncUid, body) {
    const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
    return crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${signedMethod}\n${path}\n${ncUid}\n${bodyHash}`).digest('hex');
}

function reqWithBody({ originalUrl, override, ncUid = 'alice', ts, sig, body }) {
    const req = reqFor({ originalUrl, override, ncUid, ts, sig });
    req.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    return req;
}

const UPLOAD = '/nc/remote.php/dav/files/alice/report.docx';

test('v2: a signature bound to the body verifies', () => {
    const ts = now();
    const body = 'the real report';
    const sig = signV2(ts, 'PUT', UPLOAD, 'alice', body);
    assert.equal(verifyHmac(reqWithBody({ originalUrl: UPLOAD, override: 'PUT', ts, sig, body })), true);
});

test('v2: swapping the body under a valid signature is rejected', () => {
    const ts = now();
    const sig = signV2(ts, 'PUT', UPLOAD, 'alice', 'the real report');
    assert.equal(
        verifyHmac(reqWithBody({ originalUrl: UPLOAD, override: 'PUT', ts, sig, body: 'malicious replacement' })),
        false,
        'a captured PUT signature must not authorise different file content',
    );
});

test('v2: an empty body hashes to sha256("")', () => {
    const ts = now();
    const path = '/nc/ocs/v2.php/cloud/user';
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nGET\n${path}\nalice\n${EMPTY_SHA256}`).digest('hex');
    const req = reqFor({ originalUrl: path, wireMethod: 'GET', ts, sig });
    assert.equal(verifyHmac(req), true, 'a bodyless GET must verify without req.body being set');
});

test('v1 signatures still verify during rollout (drop this once every server signs v2)', () => {
    const ts = now();
    const sig = sign(ts, 'PUT', UPLOAD, 'alice');
    assert.equal(verifyHmac(reqWithBody({ originalUrl: UPLOAD, override: 'PUT', ts, sig, body: 'anything' })), true);
});

test('a malformed (non-hex, wrong-length) signature is rejected', () => {
    const ts = now();
    const req = reqFor({ originalUrl: UPLOAD, override: 'PUT', ts, sig: 'zzzz' });
    assert.equal(verifyHmac(req), false);
});
