const test = require('node:test');
const assert = require('node:assert/strict');

// config.js requires these at load time.
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { stableInstanceIdFallback, ncHostFromUrl } = require('../src/bootstrap');

// The expected values below MUST match server/auth/connectorBootstrap.test.js —
// the two implementations are deliberate duplicates and have to agree byte-for-
// byte, otherwise the connector's X-Beeflow-NC-Instance-Id header won't match
// the id the SaaS re-derives and every fallback instance re-provisions a duplicate.

test('ncHostFromUrl extracts host (with port), null on garbage', () => {
    assert.equal(ncHostFromUrl('https://nc.example.com/'), 'nc.example.com');
    assert.equal(ncHostFromUrl('https://nc.example.com:8443/foo'), 'nc.example.com:8443');
    assert.equal(ncHostFromUrl('not a url'), null);
});

test('stableInstanceIdFallback is host-keyed and version-independent', () => {
    assert.equal(stableInstanceIdFallback('https://nc.example.com/', 'Acme'), 'nc-host:nc.example.com');
    assert.equal(stableInstanceIdFallback('https://nc.example.com:8443/foo', 'Acme'), 'nc-host:nc.example.com:8443');
});

test('stableInstanceIdFallback falls back to theming name on malformed URL', () => {
    assert.equal(stableInstanceIdFallback('not a url', 'Acme'), 'nc:Acme');
    assert.equal(stableInstanceIdFallback('', null), 'nc:nextcloud');
});
