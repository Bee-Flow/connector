const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { verifyAppApiSignature, mintSaasJwt, HDR } = require('../src/auth');
const config = require('../src/config');

function signedReq({ method = 'POST', url = '/api/x', body = '{}', skewSec = 0 } = {}) {
    const ts = Math.floor(Date.now() / 1000) + skewSec;
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonical = [method, url, bodyHash, String(ts)].join('\n');
    const sig = crypto.createHmac('sha256', config.appSecret).update(canonical).digest('base64');
    return {
        method, url, originalUrl: url, rawBody: body,
        headers: { [HDR.sig]: sig, [HDR.sigTime]: String(ts) },
    };
}

test('valid signature passes', () => {
    assert.doesNotThrow(() => verifyAppApiSignature(signedReq()));
});

test('missing headers → 401', () => {
    const req = signedReq();
    delete req.headers[HDR.sig];
    assert.throws(() => verifyAppApiSignature(req), /Missing AppAPI signature headers/);
});

test('tampered body → 401', () => {
    const req = signedReq({ body: '{"a":1}' });
    req.rawBody = '{"a":2}';
    assert.throws(() => verifyAppApiSignature(req), /Invalid AppAPI signature/);
});

test('skew beyond tolerance → 401', () => {
    const req = signedReq({ skewSec: config.sigSkewSeconds + 60 });
    assert.throws(() => verifyAppApiSignature(req), /skew/);
});

test('mintSaasJwt returns a JWT signed with tenant key', () => {
    const jwt = require('jsonwebtoken');
    const token = mintSaasJwt({ uid: 'alice', email: 'a@b', displayName: 'Alice' });
    const decoded = jwt.verify(token, config.tenantKey, { audience: 'beeflow.ai' });
    assert.equal(decoded.sub, 'alice');
    assert.equal(decoded.email, 'a@b');
});
