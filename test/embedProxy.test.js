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
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
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
        '/beeflow-runtime.js',        // the web app's runtime settings, next to the shell
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
        '/beeflow-runtime.json',
        '/x/beeflow-runtime.js',
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

// No Bee Flow server chosen: the API proxy has nowhere to forward to and
// answers by itself, and the shell proxy hands every path to the baked bundle,
// also when BEEFLOW_EMBED_BASE_URL locks a frontend host. A local listener
// stands in for that host and must see no connection.
test('no server chosen: nothing is proxied, the shell is the baked one, also with the embed lock', async () => {
    let connections = 0;
    const host = http.createServer((_req, res) => res.end('FROM_A_BEE_FLOW_HOST'));
    host.on('connection', () => { connections += 1; });
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    const hostUrl = `http://127.0.0.1:${host.address().port}`;

    const before = { apiBaseUrl: config.apiBaseUrl, embedBaseUrl: config.embedBaseUrl, embedBaseUrlLocked: config.embedBaseUrlLocked };
    config.apiBaseUrl = null;
    config.embedBaseUrl = hostUrl;
    config.embedBaseUrlLocked = true;

    const api = buildApiProxy();
    const embed = buildEmbedProxy();
    const front = http.createServer((req, res) => {
        if (req.url.startsWith('/shell')) {
            req.url = req.url.slice('/shell'.length) || '/';
            req.__shellNext = () => { res.statusCode = 200; res.end('BAKED'); };
            return embed(req, res, req.__shellNext);
        }
        // What express gives the API proxy.
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        return api(req, res, () => res.end('NEXT'));
    });
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${front.address().port}`;
    try {
        for (const p of ['/shell/', '/shell/index.html', '/shell/assets/index-abc.js']) {
            const res = await fetch(base + p);
            assert.equal(await res.text(), 'BAKED', p);
        }
        for (const [method, p] of [['GET', '/auth/user'], ['POST', '/api/chat'], ['GET', '/agents']]) {
            const res = await fetch(base + p, { method });
            assert.equal(res.status, 503, `${method} ${p}`);
            assert.equal((await res.json()).code, 'server_not_chosen', `${method} ${p}`);
        }
        assert.equal(connections, 0, 'no connection to a Bee Flow host');
    } finally {
        Object.assign(config, before);
        front.close();
        host.close();
    }
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

// The web app's runtime settings script comes from the web app host, under its
// /embed/ prefix. A host that has none (an error page, or its HTML fallback)
// is answered by the connector's own script, never by a page served as script.
test('the runtime settings script comes from the web app host; a host without one hands over to the connector', async () => {
    let asked = null;
    let answer = (res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end('window.__BEEFLOW_RUNTIME__ = Object.freeze({});');
    };
    const upstream = http.createServer((req, res) => { asked = req.url; answer(res); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    process.env.BEEFLOW_EMBED_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/proxy')];
    const fresh = require('../src/proxy');
    assert.equal(fresh.RUNTIME_SETTINGS_PATH, '/beeflow-runtime.js');
    const embedProxy = fresh.buildEmbedProxy();
    const server = http.createServer((req, res) => {
        req.__shellNext = () => { res.statusCode = 200; res.end('CONNECTOR_SCRIPT'); };
        embedProxy(req, res, req.__shellNext);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/beeflow-runtime.js`;
    try {
        const served = await fetch(url);
        assert.equal(asked, '/embed/beeflow-runtime.js');
        assert.equal(await served.text(), 'window.__BEEFLOW_RUNTIME__ = Object.freeze({});');
        assert.match(served.headers.get('content-type'), /javascript/);

        answer = (res) => { res.statusCode = 404; res.setHeader('Content-Type', 'text/html'); res.end('<pre>Cannot GET</pre>'); };
        assert.equal(await (await fetch(url)).text(), 'CONNECTOR_SCRIPT', 'a 404 page is not passed on');

        answer = (res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html></html>'); };
        assert.equal(await (await fetch(url)).text(), 'CONNECTOR_SCRIPT', 'a page with status 200 is not passed on as script');
    } finally {
        server.close();
        upstream.close();
    }
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
