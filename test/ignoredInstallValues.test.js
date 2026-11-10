// An install-time value that fixes nothing is reported the same way for every
// option: one log line that shows the value, and a setup status that does not
// name it as a fixed one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-ignored-values-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.APP_PERSISTENT_STORAGE = storage;

const NAMES = ['BEEFLOW_API_BASE_URL', 'BEEFLOW_EMBED_BASE_URL', 'BEEFLOW_NC_PUBLIC_URL'];
const SRC = path.join(__dirname, '..', 'src') + path.sep;
const realFetch = globalThis.fetch;

test.after(() => {
    for (const name of NAMES) delete process.env[name];
    fs.rmSync(storage, { recursive: true, force: true });
});

/** The connector's modules loaded afresh with these install-time values; also what was logged. */
function loadWith(values) {
    for (const name of NAMES) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
    }
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC)) delete require.cache[key];
    }
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        const config = require('../src/config');
        require('../src/setupConfig').init(storage);
        return { config, setupRouter: require('../src/setup'), warned };
    } finally {
        console.warn = realWarn;
    }
}

async function status(setupRouter) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true, language: null } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        return await (await realFetch(`http://127.0.0.1:${server.address().port}/setup/status`)).json();
    } finally {
        server.close();
    }
}

test('each ignored value gets one line that shows it', () => {
    const { warned } = loadWith(Object.fromEntries(NAMES.map((name) => [name, 'Array'])));
    for (const name of NAMES) {
        const lines = warned.filter((l) => l.includes(`ignoring ${name}`));
        assert.equal(lines.length, 1, `${name} is logged once`);
        assert.ok(lines[0].includes(`ignoring ${name} (Array): `), lines[0]);
    }
});

test('the line shows no user or password, and no more than a line holds', () => {
    const { warned } = loadWith({
        BEEFLOW_API_BASE_URL: 'ftp://someone:s3cret@files.example.org',
        BEEFLOW_NC_PUBLIC_URL: `not a url ${'x'.repeat(500)}`,
    });
    const api = warned.find((l) => l.includes('ignoring BEEFLOW_API_BASE_URL'));
    assert.ok(api.includes('(ftp://files.example.org)'), api);
    assert.ok(!api.includes('s3cret'));
    const nc = warned.find((l) => l.includes('ignoring BEEFLOW_NC_PUBLIC_URL'));
    assert.ok(nc.length < 400, 'the value is cut');
});

test('the setup status names an install-time server only when it fixes the server', async () => {
    const ignored = loadWith({ BEEFLOW_API_BASE_URL: 'Array' });
    assert.equal(ignored.config.apiBaseUrlLocked, false);
    assert.deepEqual(
        (({ envOverridden, envApiBaseUrl }) => ({ envOverridden, envApiBaseUrl }))(await status(ignored.setupRouter)),
        { envOverridden: false, envApiBaseUrl: null },
    );

    const fixed = loadWith({ BEEFLOW_API_BASE_URL: 'https://bee-flow.example' });
    assert.equal(fixed.config.apiBaseUrlLocked, true);
    assert.deepEqual(
        (({ envOverridden, envApiBaseUrl }) => ({ envOverridden, envApiBaseUrl }))(await status(fixed.setupRouter)),
        { envOverridden: true, envApiBaseUrl: 'https://bee-flow.example' },
    );
});

test('a start-up failure line ends a sentence once', () => {
    const { withoutFinalStop } = require('../src/errors');
    assert.equal(withoutFinalStop('The server refused the connection (HTTP 403): no organisations are created.'), 'The server refused the connection (HTTP 403): no organisations are created');
    assert.equal(withoutFinalStop('fetch failed'), 'fetch failed');
    assert.equal(withoutFinalStop('ends twice.. '), 'ends twice');
});
