// On a manual-install daemon the Nextcloud top bar frames `…/index.html`
// through AppAPI's PHP proxy. For a path with the extension `html` that proxy
// adds `nonce="…"` to every `<script` tag and passes the Content-Length it got
// on unchanged; a web server that does not compress then delivers exactly that
// many bytes. The page the connector sends has to survive that whole: the
// first-run page, the proxied web app shell and the shell baked into the image.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-nonce-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'auto';
process.env.APP_PERSISTENT_STORAGE = storage;
delete process.env.BEEFLOW_API_BASE_URL;
delete process.env.BEEFLOW_EMBED_BASE_URL;

const config = require('../src/config');
const setupConfig = require('../src/setupConfig');
const { unconfiguredGate } = require('../src/serverChoice');
const { buildEmbedProxy } = require('../src/proxy');
const { isNoncePath, withNonceRoom, nonceRoom } = require('../src/htmlPadding');

const SELF = 'http://bee-flow-server.test:3001';
const SETUP_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.html'), 'utf8');
// As long as the value Nextcloud writes (base64 of 32 bytes), and three times that.
const NONCES = ['n'.repeat(44), 'n'.repeat(132)];

test.after(() => fs.rmSync(storage, { recursive: true, force: true }));

/** GET a path of a listening app; the raw body and its announced length. */
async function get(app, urlPath, headers = {}) {
    const srv = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}${urlPath}`, { headers });
        const body = Buffer.from(await res.arrayBuffer());
        return { status: res.status, body, contentLength: Number(res.headers.get('content-length')) };
    } finally {
        srv.close();
    }
}

/**
 * What a browser ends up with behind AppAPI's PHP proxy without compression:
 * the nonce is added to every `<script`, the Content-Length stays, and the
 * client reads that many bytes.
 */
function throughPhpProxy({ body, contentLength }, nonce) {
    const rewritten = Buffer.from(body.toString('utf8').replaceAll('<script', `<script nonce="${nonce}"`));
    return rewritten.subarray(0, contentLength).toString('utf8');
}

test('only a path with the extension html gets room for a nonce', () => {
    assert.equal(isNoncePath('/index.html'), true);
    assert.equal(isNoncePath('/index.html?ncPath=%2Fapp%2Fprojects'), true);
    for (const p of ['/', '/setup', '/assets/index-abc.js', '/index.htm', '/x.html/y']) assert.equal(isNoncePath(p), false, p);
    for (const p of ['/.html', '/a/b.html', '/x.html?y=/z.js', '.html']) assert.equal(isNoncePath(p), true, p);
    for (const p of ['/index.HTML', '/index.html/', '/index.htmlx', '/indexhtml', '/index.html\n', '/x.js?y=.html', '', undefined]) {
        assert.equal(isNoncePath(p), false, String(p));
    }
    assert.equal(nonceRoom('<p>no script here</p>'), '');
    assert.match(withNonceRoom('<html><script>1</script></html>'), /<\/html>\n +$/);
});

test('the first-run page at /index.html arrives whole through the PHP proxy, for an administrator and for a user', async () => {
    config.apiBaseUrl = null;
    for (const isNcAdmin of [true, false]) {
        const app = express();
        app.use((req, _res, next) => { req.beeflow = { user: { uid: 'u', isNcAdmin } }; next(); });
        app.use(unconfiguredGate({ pageHtml: () => SETUP_HTML }));
        const answer = await get(app, '/index.html');
        assert.equal(answer.status, 200);
        assert.equal(answer.contentLength, answer.body.length);
        for (const nonce of NONCES) {
            const page = throughPhpProxy(answer, nonce);
            assert.match(page, /<\/script>\s*<\/body>\s*<\/html>\s*$/, `the page ends complete (nonce of ${nonce.length})`);
            assert.ok(page.includes(`<script nonce="${nonce}"`));
            assert.equal(page.includes('<body data-first-run data-can-configure>'), isNcAdmin);
        }
        // The same page where nothing is added to it (HaRP): the page, then whitespace.
        assert.equal(answer.body.toString('utf8').trimEnd().endsWith('</html>'), true);
        // `/` is not rewritten by the proxy and is sent as it is.
        const root = await get(app, '/');
        assert.equal(root.body.toString('utf8').endsWith(' '), false);
    }
});

test('the proxied web app shell at /index.html arrives whole through the PHP proxy', async () => {
    const shell = '<!doctype html><html><head><script type="importmap">{}</script><script>theme()</script>'
        + '<script type="module" src="./assets/index-abc.js"></script></head><body><div id="root"></div>'
        + '<script src="./beeflow-runtime.js"></script></body></html>';
    const asset = 'console.log("<script")';
    const frontend = http.createServer((req, res) => {
        if (req.url === '/embed/index.html') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(shell) });
            return res.end(req.method === 'HEAD' ? undefined : shell);
        }
        res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': Buffer.byteLength(asset) });
        return res.end(asset);
    });
    await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
    setupConfig.init(storage);
    setupConfig.save({ mode: 'self-hosted', apiBaseUrl: SELF, embedBaseUrl: `http://127.0.0.1:${frontend.address().port}` });
    config.apiBaseUrl = SELF;
    const app = express();
    app.use(buildEmbedProxy());
    try {
        const answer = await get(app, '/index.html');
        assert.equal(answer.status, 200);
        assert.equal(answer.contentLength, answer.body.length);
        assert.ok(answer.body.toString('utf8').startsWith(shell));
        for (const nonce of NONCES) {
            const page = throughPhpProxy(answer, nonce);
            assert.ok(page.trimEnd().endsWith('<script nonce="' + nonce + '" src="./beeflow-runtime.js"></script></body></html>'),
                `the shell ends complete (nonce of ${nonce.length})`);
        }
        // An asset is passed on byte for byte.
        const js = await get(app, '/assets/index-abc.js');
        assert.equal(js.body.toString('utf8'), asset);
    } finally {
        config.apiBaseUrl = null;
        frontend.close();
    }
});
