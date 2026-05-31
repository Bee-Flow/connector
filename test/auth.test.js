const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { decodeAuthHeader, mintSaasJwt } = require('../src/auth');
const config = require('../src/config');

test('decode shared-secret header with user', () => {
    const header = Buffer.from('alice:test-secret').toString('base64');
    const decoded = decodeAuthHeader(header);
    assert.equal(decoded.userId, 'alice');
    assert.equal(decoded.secret, 'test-secret');
});

test('decode service-level header (empty userId)', () => {
    const header = Buffer.from(':test-secret').toString('base64');
    const decoded = decodeAuthHeader(header);
    assert.equal(decoded.userId, '');
    assert.equal(decoded.secret, 'test-secret');
});

test('decode garbage returns null', () => {
    assert.equal(decodeAuthHeader('not-base64-with-no-colon'), null);
    assert.equal(decodeAuthHeader(undefined), null);
});

test('mintSaasJwt returns a JWT signed with tenant key', () => {
    const jwt = require('jsonwebtoken');
    const token = mintSaasJwt({ uid: 'alice', email: 'a@b', displayName: 'Alice' });
    const decoded = jwt.verify(token, config.tenantKey, { audience: 'beeflow.nl' });
    assert.equal(decoded.sub, 'alice');
    assert.equal(decoded.email, 'a@b');
});

test('mintSaasJwt sets nc_admin:true for an NC admin (drives the SaaS onboarding carve-out)', () => {
    const jwt = require('jsonwebtoken');
    const token = mintSaasJwt({ uid: 'boss', email: 'boss@b', displayName: 'Boss', isNcAdmin: true });
    const decoded = jwt.verify(token, config.tenantKey, { audience: 'beeflow.nl' });
    assert.equal(decoded.nc_admin, true);
});

test('mintSaasJwt sets nc_admin:false for a non-admin (no onboarding bypass)', () => {
    const jwt = require('jsonwebtoken');
    const token = mintSaasJwt({ uid: 'alice', email: 'a@b', displayName: 'Alice', isNcAdmin: false });
    const decoded = jwt.verify(token, config.tenantKey, { audience: 'beeflow.nl' });
    assert.equal(decoded.nc_admin, false);
});
