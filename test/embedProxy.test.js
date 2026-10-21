// The embedded SPA shell is proxied to the cloud `/embed/` build instead of
// being baked into the image, so a frontend deploy reaches the embedded view
// without a connector release. These tests cover the routing classification
// (which paths are the shell vs the API vs connector-local), the cloud-path
// rewrite, and the offline fallback to the baked /public bundle.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
// Leave BEEFLOW_EMBED_BASE_URL unset so the default is exercised below.

const config = require('../src/config');
const { buildApiProxy, buildEmbedProxy, isSpaShellPath, rewriteToEmbed } = require('../src/proxy');

test('embedBaseUrl defaults to the frontend front-door host', () => {
    assert.equal(config.embedBaseUrl, 'https://beeflow.nl');
});

test('SPA shell paths are classified as shell (proxied to /embed/)', () => {
    for (const p of [
        '/',
        '/index.html',
        '/assets/index-abc123.js',
        '/assets/vendor-def456.css',
        '/favicon.ico',
        '/bee-flow-logo.png',
        '/BeeFlow-logo.svg',
        '/img/screenshot.png',
        '/assets/index-abc123.js?v=2', // query preserved
        '/monaco/vs/loader.js',       // code editor runtime (vite monacoSelfHost)
        '/fonts/cabinet-grotesk/CabinetGrotesk-Variable.woff2',
        '/module-shims/react-dom-client.js', // Studio app runtime
        '/n8n-color.png',
    ]) {
        assert.equal(isSpaShellPath(p), true, `${p} should be a shell path`);
    }
});

test('API + client-route paths are NOT shell paths (stay on the SaaS api-proxy)', () => {
    for (const p of [
        '/auth/login',
        '/agents',
        '/agents/123',
        '/api/chat',
        '/automation/events',
        '/integrations/nextcloud',
        '/setup',          // handled by its own router, never the shell proxy
        '/nc/remote.php',  // HMAC reverse-proxy, mounted before auth
        '/monacoish',      // only the folder, not a prefix match
    ]) {
        assert.equal(isSpaShellPath(p), false, `${p} should NOT be a shell path`);
    }
});

test('rewriteToEmbed maps connector-local shell paths onto the cloud /embed/ prefix', () => {
    assert.equal(rewriteToEmbed('/'), '/embed/');
    assert.equal(rewriteToEmbed('/index.html'), '/embed/index.html');
    assert.equal(rewriteToEmbed('/assets/index-abc.js'), '/embed/assets/index-abc.js');
    assert.equal(rewriteToEmbed('/bee-flow-logo.png'), '/embed/bee-flow-logo.png');
    // pathRewrite receives the query string too — it must be preserved.
    assert.equal(rewriteToEmbed('/assets/x.js?v=1'), '/embed/assets/x.js?v=1');
});

test('buildApiProxy / buildEmbedProxy return middleware functions', () => {
    assert.equal(typeof buildApiProxy(), 'function');
    assert.equal(typeof buildEmbedProxy(), 'function');
});

// When the cloud frontend host is unreachable, the embed proxy must NOT 502 —
// it calls the stashed req.__shellNext so the request falls through to the
// baked /public static handler (offline fallback). Point the proxy at a
// refused port and assert the fallback runs.
test('embed proxy falls back to next() (baked /public) when the cloud is unreachable', (_, done) => {
    process.env.BEEFLOW_EMBED_BASE_URL = 'http://127.0.0.1:1'; // connection refused
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/proxy')];
    const { buildEmbedProxy: freshBuild } = require('../src/proxy');
    const embedProxy = freshBuild();

    const server = http.createServer((req, res) => {
        // Mirror server.js: stash the fallback, then hand off to the proxy.
        req.__shellNext = () => { res.statusCode = 200; res.end('FELL_BACK_TO_PUBLIC'); };
        embedProxy(req, res, req.__shellNext);
    });

    server.listen(0, () => {
        const { port } = server.address();
        http.get(`http://127.0.0.1:${port}/`, (r) => {
            let body = '';
            r.on('data', (d) => { body += d; });
            r.on('end', () => {
                server.close();
                assert.equal(r.statusCode, 200);
                assert.equal(body, 'FELL_BACK_TO_PUBLIC');
                done();
            });
        });
    });
});

// Nextcloud's AppAPI proxy copies the browser's `Accept-Encoding: gzip` onto
// its request to us, the frontend host gzips text/html, and for `*.html`
// AppAPI buffers + decodes the body to inject its CSP nonce — a path that
// delivered a 200 with an EMPTY body (NC 34 / AppAPI 34, 2026-09-10). The shell
// hop therefore asks for identity, whatever the browser asked for.
test('embed proxy asks the frontend host for an uncompressed shell', (_, done) => {
    let seenEncoding = null;
    const upstream = http.createServer((req, res) => {
        seenEncoding = req.headers['accept-encoding'];
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><script>1</script></html>');
    });
    upstream.listen(0, () => {
        process.env.BEEFLOW_EMBED_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
        delete require.cache[require.resolve('../src/config')];
        delete require.cache[require.resolve('../src/proxy')];
        const { buildEmbedProxy: freshBuild } = require('../src/proxy');
        const embedProxy = freshBuild();

        const server = http.createServer((req, res) => {
            req.__shellNext = () => { res.statusCode = 500; res.end('FELL_BACK'); };
            embedProxy(req, res, req.__shellNext);
        });
        server.listen(0, () => {
            const { port } = server.address();
            http.get({ host: '127.0.0.1', port, path: '/index.html', headers: { 'accept-encoding': 'gzip, deflate, br' } }, (r) => {
                let body = '';
                r.on('data', (d) => { body += d; });
                r.on('end', () => {
                    server.close(); upstream.close();
                    assert.equal(r.statusCode, 200);
                    assert.equal(seenEncoding, 'identity', 'the browser\'s gzip preference must not reach the shell host');
                    assert.match(body, /<script>1<\/script>/);
                    done();
                });
            });
        });
    });
});
