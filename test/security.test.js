// Response hardening + cross-site request rejection.
//
// These pin the two guarantees a PHP Nextcloud app gets from the framework and
// an ExApp has to provide itself: `frame-ancestors` naming only origins that
// really are this Nextcloud (developer_manual/prologue/security.html,
// clickjacking), and a CSRF check that AppAPI's #[NoCSRFRequired] proxy does not
// perform for us.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'https://cloud.example.com';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const security = require('../src/security');

function resStub() {
    const headers = {};
    return {
        headers,
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        set: (k, v) => { headers[k.toLowerCase()] = v; },
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function run(middleware, req) {
    const res = resStub();
    let nexted = false;
    middleware(req, res, () => { nexted = true; });
    return { res, nexted };
}

test('frame-ancestors names this Nextcloud, not whoever framed us', () => {
    security._resetOriginLog();
    const value = security.frameAncestorsFor({
        headers: { referer: 'https://evil.example/attack.html' },
    });
    assert.ok(value.includes('https://cloud.example.com'), `expected NC origin, got: ${value}`);
    assert.ok(!value.includes('evil.example'),
        `a site that frames us must not be able to name itself as an allowed framer: ${value}`);
});

test('an Origin header cannot smuggle an extra framer in either', () => {
    security._resetOriginLog();
    const value = security.frameAncestorsFor({
        headers: { origin: 'https://evil.example' },
    });
    assert.ok(!value.includes('evil.example'));
});

test('BEEFLOW_TRUSTED_EMBED_ORIGINS is how a real reverse proxy gets listed', () => {
    const before = process.env.BEEFLOW_TRUSTED_EMBED_ORIGINS;
    process.env.BEEFLOW_TRUSTED_EMBED_ORIGINS = 'https://nc.customer.example, http://localhost:8080';
    try {
        const value = security.frameAncestorsFor({ headers: {} });
        assert.ok(value.includes('https://nc.customer.example'));
        assert.ok(value.includes('http://localhost:8080'));
    } finally {
        if (before === undefined) delete process.env.BEEFLOW_TRUSTED_EMBED_ORIGINS;
        else process.env.BEEFLOW_TRUSTED_EMBED_ORIGINS = before;
    }
});

test('every response carries nosniff, no-referrer and noindex', () => {
    const { res, nexted } = run(security.securityHeaders, { headers: {} });
    assert.ok(nexted);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.match(res.headers['content-security-policy'], /^frame-ancestors /);
});

test('a cross-site POST is refused — AppAPI does no CSRF check for us', () => {
    const { res, nexted } = run(security.rejectCrossSiteWrites, {
        method: 'POST', path: '/setup', headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'cross_site_request_blocked');
});

test('the SPA in its Nextcloud iframe is same-origin and passes', () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
        const { nexted } = run(security.rejectCrossSiteWrites, {
            method: 'POST', path: '/setup', headers: { 'sec-fetch-site': site },
        });
        assert.equal(nexted, true, `sec-fetch-site: ${site} must pass`);
    }
});

test('server-to-server callers (no Sec-Fetch-Site) pass and are judged by their signature', () => {
    const { nexted } = run(security.rejectCrossSiteWrites, {
        method: 'POST', path: '/hooks/talk', headers: {},
    });
    assert.equal(nexted, true);
});

test('reads are never blocked — the check is for state changes', () => {
    const { nexted } = run(security.rejectCrossSiteWrites, {
        method: 'GET', path: '/', headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(nexted, true);
});
