// A Nextcloud account without an e-mail address cannot sign in to Bee Flow.
// The connector says so itself, in the user's language: a small page for a page
// load, 403 with code no_email for a call the web app makes. Nothing of such a
// request is forwarded. Setup and the administrator routes work without an
// address, and so does the web app while the connector has no tenant key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-noemail-'));

const express = require('express');
const { installFakeWorld, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const auth = require('../src/auth');
const { buildApiProxy } = require('../src/proxy');
const { noEmailGate, noEmailPage, NO_EMAIL_TEXTS } = require('../src/noEmail');

const nl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'nl.json'), 'utf8'));

// uid → what Nextcloud knows about the account.
const USERS = {
    anna: { email: null, groups: [], language: 'nl' },
    eric: { email: '', groups: [], language: 'en' },
    root: { email: null, groups: ['admin'], language: '' },
    mail: { email: 'mail@nc.test', groups: [], language: 'nl' },
};

/** @type {import('node:http').Server} */ let beeflow;
/** @type {import('node:http').Server} */ let connector;
/** @type {{ method: string, url: string }[]} */ const forwarded = [];
let world;
let connectorPort = 0;

test.before(async () => {
    // The Bee Flow server: records what reaches it.
    beeflow = http.createServer((req, res) => {
        forwarded.push({ method: req.method, url: req.url });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => beeflow.listen(0, '127.0.0.1', resolve));
    config.apiBaseUrl = `http://127.0.0.1:${beeflow.address().port}`;

    // Nextcloud's user lookup is a fetch; the proxy hop is a real connection.
    world = installFakeWorld({
        nc: (_method, url) => {
            const hit = /\/cloud\/users\/([^?]+)/.exec(url);
            if (!hit) return undefined;
            const uid = decodeURIComponent(hit[1]);
            const user = USERS[uid];
            if (!user) return ocs({}, 404);
            return ocs({ id: uid, email: user.email, displayname: uid, groups: user.groups, language: user.language });
        },
    });

    // The order of server.js: the gate of AppAPI, the setup routes, this gate,
    // the API proxy, the web app.
    const app = express();
    app.use(auth.appApiAuthMiddleware);
    app.use(express.json());
    app.use('/setup', require('../src/setup'));
    app.use(noEmailGate);
    const proxy = buildApiProxy();
    app.use((req, res, next) => {
        if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/assets/')) return next();
        return proxy(req, res, next);
    });
    app.use((_req, res) => res.type('html').send('<html><body data-web-app></body></html>'));
    connector = http.createServer(app);
    await new Promise((resolve) => connector.listen(0, '127.0.0.1', resolve));
    connectorPort = connector.address().port;
});

test.after(async () => {
    world.restore();
    connector.closeAllConnections();
    beeflow.closeAllConnections();
    await new Promise((resolve) => connector.close(resolve));
    await new Promise((resolve) => beeflow.close(resolve));
    fs.rmSync(process.env.APP_PERSISTENT_STORAGE, { recursive: true, force: true });
});

test.beforeEach(() => {
    forwarded.length = 0;
    auth._resetUserCacheForTests();
});

/** A request as Nextcloud's AppAPI proxy hands it over for this user. */
function call(uid, method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: connectorPort, method, path: urlPath,
            headers: {
                'authorization-app-api': Buffer.from(`${uid}:test-secret`).toString('base64'),
                'ex-app-id': config.appId,
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...headers,
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };
const XHR = { 'sec-fetch-mode': 'cors', accept: '*/*' };

test('a page load gets a small page in the user\'s language, and nothing is forwarded', async () => {
    for (const urlPath of ['/', '/index.html', '/app/chat']) {
        const res = await call('anna', 'GET', urlPath, NAVIGATE);
        assert.equal(res.status, 200, urlPath);
        assert.match(res.headers['content-type'], /^text\/html/);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.ok(res.text.includes('data-no-email'), urlPath);
        assert.ok(res.text.includes(nl.translations[NO_EMAIL_TEXTS.title]), 'Dutch title');
        assert.ok(res.text.includes(nl.translations[NO_EMAIL_TEXTS.body]), 'Dutch body');
        assert.ok(!res.text.includes('<script'), 'the page runs nothing');
    }
    const english = await call('eric', 'GET', '/', NAVIGATE);
    assert.ok(english.text.includes(NO_EMAIL_TEXTS.title));
    assert.ok(english.text.includes('Personal settings'));
    assert.deepEqual(forwarded, []);
});

test('a call of the web app gets 403 with code no_email, and nothing is forwarded', async () => {
    const get = await call('anna', 'GET', '/auth/user', XHR);
    assert.equal(get.status, 403);
    assert.deepEqual(JSON.parse(get.text), { code: 'no_email', error: nl.translations[NO_EMAIL_TEXTS.title] });

    const post = await call('eric', 'POST', '/api/chat/stream', XHR, { message: 'hello' });
    assert.equal(post.status, 403);
    assert.deepEqual(JSON.parse(post.text), { code: 'no_email', error: NO_EMAIL_TEXTS.title });

    // A POST that claims to be a navigation is still a call.
    const claimed = await call('anna', 'POST', '/agents', NAVIGATE, {});
    assert.equal(claimed.status, 403);
    assert.deepEqual(forwarded, []);
});

test('an account with an address is not touched: the page is the web app and calls are forwarded', async () => {
    const page = await call('mail', 'GET', '/', NAVIGATE);
    assert.ok(page.text.includes('data-web-app'));
    const res = await call('mail', 'GET', '/auth/user', XHR);
    assert.equal(res.status, 200);
    assert.deepEqual(forwarded, [{ method: 'GET', url: '/auth/user' }]);
});

test('an address added in Nextcloud counts at the next page load', async () => {
    USERS.late = { email: null, groups: [], language: 'en' };
    assert.ok((await call('late', 'GET', '/', NAVIGATE)).text.includes('data-no-email'));
    USERS.late.email = 'late@nc.test';
    assert.ok((await call('late', 'GET', '/', NAVIGATE)).text.includes('data-web-app'));
});

test('setup and the administrator routes work for an administrator without an address', async () => {
    const status = await call('root', 'GET', '/setup/status', XHR);
    assert.equal(status.status, 200, status.text);
    assert.equal(JSON.parse(status.text).canConfigure, true);

    const diagnostics = await call('root', 'GET', '/setup/diagnostics', XHR);
    assert.equal(diagnostics.status, 200, diagnostics.text);

    const page = await call('root', 'GET', '/setup', NAVIGATE);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('data-no-email'));
    assert.deepEqual(forwarded, []);
});

test('the web app\'s own static files pass', async () => {
    const res = await call('anna', 'GET', '/assets/index-abc.js', { 'sec-fetch-mode': 'no-cors' });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('data-web-app'));
});

test('without a tenant key the web app is the setup screen, also for an account without an address', async () => {
    const key = config.tenantKey;
    config.tenantKey = null;
    try {
        const page = await call('root', 'GET', '/', NAVIGATE);
        assert.equal(page.status, 200);
        assert.ok(page.text.includes('data-web-app'));
        // The existing answer of that state for a call, not this gate's.
        const xhr = await call('root', 'GET', '/auth/user', XHR);
        assert.equal(xhr.status, 502);
    } finally {
        config.tenantKey = key;
    }
    assert.deepEqual(forwarded, []);
});

test('the page names its language and both texts have a Dutch translation', () => {
    assert.ok(nl.translations[NO_EMAIL_TEXTS.title]);
    assert.ok(nl.translations[NO_EMAIL_TEXTS.body]);
    assert.match(noEmailPage('nl'), /<html lang="nl">/);
    assert.match(noEmailPage('en'), /<html lang="en">/);
});
