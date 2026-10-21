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
// email-named calendars (`tomsmit@beeflow.nl`).
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

// ── Path allow-list ─────────────────────────────────────────────────────────
//
// The /nc/* route forwards into Nextcloud with the AppAPI shared secret and an
// impersonated uid, so "which paths" is a real authorisation boundary and not
// just routing. Three prefixes are allowed; `..` must not be able to walk out
// of them, in any spelling (developer_manual/prologue/security.html, directory
// traversal).
const { isAllowedNcPath } = require('../src/ncProxy');

test('the three documented prefixes are forwarded', () => {
    for (const p of [
        '/ocs/v2.php/cloud/user',
        '/remote.php/dav/files/alice/notes.md',
        '/index.php/apps/spreed/api/v1/room',
        '/ocs/v2.php/cloud/users/alice?format=json',
    ]) {
        assert.equal(isAllowedNcPath(p), true, `${p} should be forwarded`);
    }
});

test('anything outside them is not', () => {
    for (const p of ['/settings/admin', '/index.php/settings/admin', '/', '/core/ajax/update.php']) {
        assert.equal(isAllowedNcPath(p), false, `${p} must not be forwarded`);
    }
});

test('a traversal segment cannot satisfy the prefix and then walk out of it', () => {
    for (const p of [
        '/ocs/../settings/admin',
        '/ocs/v2.php/../../index.php/settings/admin',
        '/ocs/%2e%2e/settings/admin',
        '/ocs/%252e%252e/settings/admin',
        '/ocs/..%2fsettings/admin',
        String.raw`/ocs/..\settings\admin`, // backslash separators, as Windows-flavoured clients send them
    ]) {
        assert.equal(isAllowedNcPath(p), false, `${p} must be refused`);
    }
});

test('a percent-encoded prefix does not smuggle a path past the allow-list', () => {
    // Decoding to an allowed prefix is not enough — the raw path must be
    // allowed too, because that is the form the upstream request carries.
    assert.equal(isAllowedNcPath('/%6fcs/v2.php/cloud/user'), false);
});

// ---- Canonical query (the AppAPI/HaRP hop re-encodes it: %20 -> +) --------

const { canonicalQuery, canonicalSignedPath } = require('../src/ncProxy');

function signCanonical(ts, method, path, ncUid) {
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    return crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\n${method}\n${path}\n${ncUid}\n${bodyHash}\nc1`).digest('hex');
}

test('a query the hop turned from %20 into + still verifies (space, +, & in values)', () => {
    const ts = now();
    // The SaaS signs the canonical form of `term=a%20b%26c%2Bd`.
    const signed = '/nc/ocs/x?term=a%20b%26c%2Bd';
    const sig = signCanonical(ts, 'GET', signed, 'alice');
    for (const arrived of ['/nc/ocs/x?term=a+b%26c%2Bd', '/nc/ocs/x?term=a%20b%26c%2Bd']) {
        assert.equal(verifyHmac(reqFor({ originalUrl: arrived, wireMethod: 'GET', ts, sig })), true, arrived);
    }
});

test('a different query under the same signature is rejected', () => {
    const ts = now();
    const sig = signCanonical(ts, 'GET', '/nc/ocs/x?term=a%20b', 'alice');
    for (const arrived of ['/nc/ocs/x?term=a%20c', '/nc/ocs/x?term=a%26b', '/nc/ocs/x?term=a%2Bb', '/nc/ocs/x?term=a&b=']) {
        assert.equal(verifyHmac(reqFor({ originalUrl: arrived, wireMethod: 'GET', ts, sig })), false, arrived);
    }
});

test('a canonical signature over term=a%20b does NOT verify term=a%2520b (no query swap via the decoded form)', () => {
    const ts = now();
    const sig = signCanonical(ts, 'GET', '/nc/ocs/x?term=a%20b%26c', 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: '/nc/ocs/x?term=a%20b%26c', wireMethod: 'GET', ts, sig })), true);
    assert.equal(verifyHmac(reqFor({ originalUrl: '/nc/ocs/x?term=a%2520b%2526c', wireMethod: 'GET', ts, sig })), false);
});

test('a legacy (unmarked) signature cannot be replayed as canonical, and the reverse', () => {
    const ts = now();
    const legacy = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nGET\n/nc/ocs/x?term=a b\nalice\n${EMPTY_SHA256}`).digest('hex');
    // Same bytes, but canonical form of `term=a%20b` is not the legacy string.
    assert.equal(verifyHmac(reqFor({ originalUrl: '/nc/ocs/x?term=a+b', wireMethod: 'GET', ts, sig: legacy })), false);
});

test('an invalid UTF-8 escape refuses the canonical form; %FF and %FE do not collide', () => {
    assert.throws(() => canonicalQuery('a=%FF'), URIError);
    assert.notEqual(canonicalSignedPath('/nc/x?a=%41'), null);
    assert.equal(canonicalSignedPath('/nc/x?a=%FF'), null);
    const ts = now();
    const sig = signCanonical(ts, 'GET', '/nc/x?a=%41', 'alice');
    assert.equal(verifyHmac(reqFor({ originalUrl: '/nc/x?a=%FF', wireMethod: 'GET', ts, sig })), false);
});

test('shared vector: the exact header the server emits verifies (tenant key k, ts 1700000000)', () => {
    const original = config.tenantKey;
    const realNow = Date.now;
    config.tenantKey = 'k';
    Date.now = () => 1700000000 * 1000;
    try {
        const req = reqFor({
            originalUrl: '/nc/ocs/x?term=a+b%26c%2Bd', wireMethod: 'GET', ts: 1700000000,
            sig: '2965e7da7a070ac22f8859397b0220b3bec73431d1552795577c29e0de56f2c4',
        });
        assert.equal(verifyHmac(req), true);
        req.originalUrl = '/nc/ocs/x?term=a+b%26c%2Be';
        assert.equal(verifyHmac(req), false);
    } finally { config.tenantKey = original; Date.now = realNow; }
});

test('canonicalQuery matches the server vector and escapes the delimiters injectively', () => {
    assert.equal(canonicalQuery('term=a+b%26c%2Bd'), canonicalQuery('term=a%20b%26c%2Bd'));
    assert.equal(canonicalQuery('term=a%20b%26c%2Bd'), 'term=a%20b%26c%2Bd');
    assert.equal(canonicalQuery('t=a+b'), 't=a%20b');
    assert.equal(canonicalQuery('a=1%0A2'), 'a=1%0A2');
    assert.notEqual(canonicalQuery('a=1%262'), canonicalQuery('a=1&2='));
});
