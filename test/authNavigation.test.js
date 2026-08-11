/**
 * "Is this a page load or an API call?" — the question auth.js gets wrong at its
 * peril.
 *
 * When the tenant key is missing or the OCS user lookup fails, a top-level
 * NAVIGATION should still get the SPA shell (so its error overlay can render),
 * while an API call must fail closed with a 502. The old test was
 * `req.accepts(['html','json']) === 'html'`, which is exactly backwards for
 * fetch(): the SPA sets no Accept header, the browser sends `Accept: *&#47;*`, and
 * content negotiation resolves that to the first offered type — 'html'. So every
 * XHR was classified as a navigation, the 502 branches were unreachable, and the
 * chat POST was forwarded to the Bee Flow server with NO Authorization header.
 */
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const test = require('node:test');
const assert = require('node:assert');
const { isDocumentNavigation } = require('../src/auth');

const req = (method, headers = {}) => ({ method, headers });

test('a real top-level navigation is a navigation', () => {
    assert.equal(isDocumentNavigation(req('GET', {
        'sec-fetch-mode': 'navigate',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })), true);
});

test('the SPA chat POST is NOT a navigation (the regression)', () => {
    // authFetch sends no Accept header; the browser fills in */*.
    assert.equal(isDocumentNavigation(req('POST', {
        'sec-fetch-mode': 'cors',
        accept: '*/*',
    })), false);
});

test('a fetch() GET with Accept: */* is NOT a navigation', () => {
    assert.equal(isDocumentNavigation(req('GET', { 'sec-fetch-mode': 'cors', accept: '*/*' })), false);
});

test('a same-origin XHR announcing itself as such is NOT a navigation', () => {
    assert.equal(isDocumentNavigation(req('GET', { 'sec-fetch-mode': 'same-origin' })), false);
});

test('an iframe load counts as a navigation', () => {
    // The embed loads the SPA into an iframe; Chrome reports mode=navigate there.
    assert.equal(isDocumentNavigation(req('GET', {
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', accept: 'text/html',
    })), true);
});

test('no Sec-Fetch-Mode: fall back to an explicit text/html GET', () => {
    assert.equal(isDocumentNavigation(req('GET', { accept: 'text/html,*/*;q=0.8' })), true);
    assert.equal(isDocumentNavigation(req('GET', { accept: '*/*' })), false);
    assert.equal(isDocumentNavigation(req('GET', {})), false);
});

test('a body-bearing method is never a navigation, whatever it claims', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(
            isDocumentNavigation(req(method, { 'sec-fetch-mode': 'navigate', accept: 'text/html' })),
            false,
            `${method} must not be treated as a document navigation`,
        );
    }
});
