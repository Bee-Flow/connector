// A server is chosen, connecting to it failed, there is no key.
//
// A page load then gets the connector's setup page, where the connection is
// finished: an administrator the whole page, with the failure and its remedy;
// everybody else a notice, and that page makes no request. GET setup/diagnostics answers somebody who is
// not an administrator with one line, so asking it is never refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { installWithStorage, NO_SERVER } = require('./support/installValues');

const OWN = 'https://bee-flow.example';
const storage = installWithStorage('bf-connector-connect-failed-', NO_SERVER);

const { installFakeWorld, json } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');
const setupRouter = require('../src/setup');

const SETUP_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.html'), 'utf8');
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const XHR = { 'sec-fetch-mode': 'cors', accept: 'application/json' };

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

/** The gate as server.js mounts it, in front of a stand-in for the web app. */
async function get(pathname, { isNcAdmin, headers = NAVIGATE, failed = () => bootstrap.connectFailed() }) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: isNcAdmin ? 'admin' : 'alice', isNcAdmin, language: null } }; next(); });
    app.use('/setup', setupRouter);
    app.use(serverChoice.connectFailedGate({ pageHtml: () => SETUP_HTML, connectFailed: failed }));
    app.use((_req, res) => res.type('text/plain').send('the web app'));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        // node:http, not fetch: fetch writes its own Sec-Fetch-Mode.
        return await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: server.address().port, path: pathname, headers }, (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { text += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, text, type: String(res.headers['content-type'] || '') }));
            }).on('error', reject);
        });
    } finally {
        server.close();
    }
}

function freshInstall() {
    setupConfig.init(storage);
    setupConfig.clear();
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    serverChoice.applyAtBoot(config, setupConfig.get());
    config.tenantKey = null;
    config.organizationId = null;
    config.organizationName = null;
    config.pairingCode = null;
}

const PAIRING_REQUIRED = () => json({ error: 'This Bee Flow server does not auto-create organisations for new Nextcloud instances.', code: 'pairing_required' }, 403);

test('no server chosen, and a connected install: the gate does nothing', async () => {
    freshInstall();
    assert.equal(bootstrap.connectFailed(), false, 'no server: that state has its own page');
    assert.equal((await get('/', { isNcAdmin: true })).text, 'the web app');

    const world = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'k', organizationId: 'o' }) } } });
    try {
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN });
    } finally {
        world.restore();
    }
    assert.equal(bootstrap.connectFailed(), false);
    for (const isNcAdmin of [true, false]) {
        assert.equal((await get('/', { isNcAdmin })).text, 'the web app');
        assert.equal((await get('/index.html', { isNcAdmin })).text, 'the web app');
    }
});

test('a first choice whose connect is refused: the page an administrator opens shows the setup page, and diagnostics has the cause', async () => {
    freshInstall();
    const world = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': PAIRING_REQUIRED } } });
    try {
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch(() => {});
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(bootstrap.connectFailed(), true);

        for (const pathname of ['/', '/index.html', '/app/agents']) {
            const page = await get(pathname, { isNcAdmin: true });
            assert.equal(page.status, 200);
            assert.match(page.type, /text\/html/);
            assert.ok(page.text.includes('<body data-connect-failed>'), `${pathname}: the whole setup page`);
            assert.ok(!page.text.includes('<body data-first-run'), 'not the notice');
        }
        // What that page reads when it opens.
        const diagnostics = JSON.parse((await get('/setup/diagnostics', { isNcAdmin: true, headers: XHR })).text);
        assert.equal(diagnostics.state, 'failed');
        assert.equal(diagnostics.connectError.code, 'pairing_code_required');
        assert.ok(diagnostics.lastError.remediation.startsWith(`Your Bee Flow server (${OWN})`));
        assert.ok(diagnostics.lastError.error.startsWith(`Your Bee Flow server (${OWN}) refused the connection (HTTP 403)`));

        // Everybody else: the notice, on a page whose script stops before any request.
        const notice = await get('/', { isNcAdmin: false });
        assert.ok(notice.text.includes('<body data-first-run data-connect-failed>'));
        assert.ok(notice.text.includes('<h1 class="connect-failed-only">Bee Flow is not connected yet</h1>'), 'the notice has the heading of this state');
        assert.ok(notice.text.includes('<h1 class="not-chosen-only">'), 'and the heading of the other state is one the page hides');

        // Only page loads: the app's own calls and the setup routes pass.
        assert.equal((await get('/auth/user', { isNcAdmin: true, headers: XHR })).text, 'the web app');
        assert.equal((await get('/js/embed.js', { isNcAdmin: true, headers: NAVIGATE })).text, 'the web app');

        // With the code the install connects, and the app is served again.
        world.restore();
        const bound = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'paired', organizationId: 'org' }) } } });
        try {
            await bootstrap.invalidateAndRebootstrap({ pairingCode: 'ABCD-1234' });
        } finally {
            bound.restore();
        }
        assert.equal(bootstrap.connectFailed(), false);
        assert.equal((await get('/', { isNcAdmin: true })).text, 'the web app');
        assert.equal((await get('/', { isNcAdmin: false })).text, 'the web app');
    } finally {
        world.restore();
    }
});

test('setup/diagnostics answers somebody who is not an administrator with one line and nothing of the diagnosis', async () => {
    const answer = await get('/setup/diagnostics', { isNcAdmin: false, headers: XHR });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { canConfigure: false });
    const admin = JSON.parse((await get('/setup/diagnostics', { isNcAdmin: true, headers: XHR })).text);
    assert.equal(typeof admin.state, 'string');
    assert.equal(admin.apiBaseUrl, config.apiBaseUrl);
});

test('the page for the connect-failed state keeps its markers apart from first-run mode', () => {
    assert.ok(serverChoice.connectFailedPage('<html><body></body></html>', true).includes('<body data-connect-failed>'));
    assert.ok(serverChoice.connectFailedPage('<html><body></body></html>', false).includes('<body data-first-run data-connect-failed>'));
    assert.ok(serverChoice.firstRunPage('<html><body></body></html>', true).includes('<body data-first-run data-can-configure>'));
});
