// BEEFLOW_EMBED_BASE_URL fixes the host of the web app shell only when it holds
// the URL of a host. Any other text (a stray word, a value filled in by the
// deploy tooling) fixes nothing: the shell host follows the server choice and
// the app keeps being served. A handler that throws answers a plain 500.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-embedval-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.APP_PERSISTENT_STORAGE = storage;
delete process.env.BEEFLOW_API_BASE_URL;

const express = require('express');
const SELF = 'http://bee-flow-server.test:3001';

test.after(() => fs.rmSync(storage, { recursive: true, force: true }));

/** config.js loaded afresh with this BEEFLOW_EMBED_BASE_URL. */
function configWith(value) {
    if (value === undefined) delete process.env.BEEFLOW_EMBED_BASE_URL;
    else process.env.BEEFLOW_EMBED_BASE_URL = value;
    for (const m of ['config', 'embedTarget', 'setupConfig', 'proxy']) {
        delete require.cache[require.resolve(`../src/${m}`)];
    }
    return require('../src/config');
}

test('a value that is not a URL is no lock; the URL of a host is', () => {
    for (const value of ['Array', 'yes', 'ftp://files.example.org', 'http://169.254.169.254', '   ']) {
        const config = configWith(value);
        assert.equal(config.embedBaseUrlLocked, false, `"${value}" locks nothing`);
        assert.equal(config.embedBaseUrl, 'https://beeflow.nl', `"${value}" is not kept as the shell host`);
    }
    const locked = configWith('https://bee.example.org/');
    assert.equal(locked.embedBaseUrlLocked, true);
    assert.equal(locked.embedBaseUrl, 'https://bee.example.org');
    assert.equal(configWith('https://beeflow.nl').embedBaseUrlLocked, false, 'the Cloud frontend address is no lock');
});

test('with "Array" in the value, the shell of a chosen server comes from the saved web app address', async () => {
    const config = configWith('Array');
    const setupConfig = require('../src/setupConfig');
    setupConfig.init(storage);
    const seen = [];
    const frontend = http.createServer((req, res) => {
        seen.push(req.url);
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>shell</title>');
    });
    await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
    const embedBaseUrl = `http://127.0.0.1:${frontend.address().port}`;
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl });
    config.apiBaseUrl = SELF;

    const { shellBaseUrl } = require('../src/embedTarget');
    assert.equal(shellBaseUrl(), embedBaseUrl);

    const { buildEmbedProxy } = require('../src/proxy');
    const { terminalErrorHandler } = require('../src/httpGuards');
    const app = express();
    app.use(buildEmbedProxy());
    app.use(terminalErrorHandler);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/index.html`);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /<title>shell<\/title>/);
        assert.deepEqual(seen, ['/embed/index.html']);
    } finally {
        srv.close();
        frontend.close();
    }
});

test('a handler that throws answers a plain 500 without a stack trace', async () => {
    const { terminalErrorHandler } = require('../src/httpGuards');
    const app = express();
    app.get('/boom', () => { throw new TypeError('Invalid URL /app/node_modules/secret-path.js'); });
    app.use(terminalErrorHandler);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.once('listening', resolve));
    const warn = console.error;
    console.error = () => {};
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/boom`);
        const body = await res.text();
        assert.equal(res.status, 500);
        assert.match(res.headers.get('content-type') || '', /application\/json/);
        assert.doesNotMatch(body, /Invalid URL|node_modules|TypeError|\bat\b .*\(/);
    } finally {
        console.error = warn;
        srv.close();
    }
});
