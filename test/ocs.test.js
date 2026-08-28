// OCS response evaluation. The bug this guards against: /ocs/v1.php answers
// HTTP 200 even when it REFUSES, with the real outcome in ocs.meta.statuscode,
// so reading only the HTTP status logs a rejected registration as success.
const test = require('node:test');
const assert = require('node:assert/strict');

const { OCS_OK, readOcsStatus, ocsSucceeded } = require('../src/ocs');

// A minimal fetch-Response stand-in: only `ok`/`status` are read.
function res(status, ok = status >= 200 && status < 300) { return { status, ok }; }
const envelope = (code) => JSON.stringify({ ocs: { meta: { statuscode: code }, data: [] } });

test('readOcsStatus reads a JSON envelope', () => {
    assert.equal(readOcsStatus(envelope(100)), 100);
    assert.equal(readOcsStatus(envelope(400)), 400);
});

test('readOcsStatus reads an XML envelope', () => {
    assert.equal(readOcsStatus('<?xml version="1.0"?><ocs><meta><statuscode>409</statuscode></meta></ocs>'), 409);
});

test('readOcsStatus is null when there is no envelope', () => {
    assert.equal(readOcsStatus('{}'), null);
    assert.equal(readOcsStatus('not json and not xml'), null);
    assert.equal(readOcsStatus(''), null);
});

test('OCS v1 success is statuscode 100 on HTTP 200 — counted as success', () => {
    assert.equal(ocsSucceeded(res(200), envelope(100), 'POST').ok, true);
});

test('an in-band OCS refusal (HTTP 200 + statuscode 400) is NOT success', () => {
    const { ok, code } = ocsSucceeded(res(200), envelope(400), 'POST');
    assert.equal(ok, false, 'this is the top-menu/settings bug — a refusal must not read as registered');
    assert.equal(code, 400);
});

test('409 already-registered is success in both HTTP and OCS form (idempotent re-register)', () => {
    assert.equal(ocsSucceeded(res(409), envelope(409), 'POST').ok, true);
    assert.equal(ocsSucceeded(res(200), envelope(409), 'POST').ok, true);
    assert.ok(OCS_OK.has(409));
});

test('no envelope falls back to the HTTP status', () => {
    assert.equal(ocsSucceeded(res(200), '{}', 'POST').ok, true);
    assert.equal(ocsSucceeded(res(500), 'upstream boom', 'POST').ok, false);
});

test('DELETE treats 404 as already-gone; POST 404 is a real failure', () => {
    assert.equal(ocsSucceeded(res(404), '', 'DELETE').ok, true);
    assert.equal(ocsSucceeded(res(200), envelope(404), 'DELETE').ok, true);
    assert.equal(ocsSucceeded(res(404), '', 'POST').ok, false);
});
