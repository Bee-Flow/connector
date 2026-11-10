// Runs in a child process of serverTls.test.js (and serverProxy.test.js): the
// connector's modules read their install-time values when they load, so each
// combination of values gets a process of its own.
//
// Input: the environment, plus RUNNER_TARGETS (JSON: name → URL). For every
// target it reports what Node's fetch does (through the dispatcher the
// connector installs at boot) and what the API proxy does, and for the target
// named `stream` whether an event stream arrives piece by piece.
//
// Output: one line `RESULT <json>` on stdout.

'use strict';

const http = require('node:http');
const express = require('express');

const config = require('../../src/config');
const { getGlobalDispatcher } = require('undici');
const before = getGlobalDispatcher();
require('../../src/ncTls').installNcDispatcher();
const { buildApiProxy } = require('../../src/proxy');
const { isCertificateError } = require('../../src/serverProbe');
const { categoriseError } = require('../../src/bootstrap');
const serverTls = require('../../src/serverTls');

const targets = JSON.parse(process.env.RUNNER_TARGETS || '{}');

/** The chain of error codes of a failed fetch, outermost first. */
function codesOf(err) {
    const out = [];
    for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) if (e.code) out.push(e.code);
    return out;
}

async function viaFetch(url) {
    try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5_000) });
        return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (err) {
        return {
            ok: false, status: 0, codes: codesOf(err), certificate: isCertificateError(err),
            category: categoriseError(err, 'saas_post'),
        };
    }
}

/** One request through the connector's API proxy to `url`. */
function viaProxy(port, url, urlPath) {
    config.apiBaseUrl = url;
    return new Promise((resolve) => {
        const started = Date.now();
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            /** @type {{ at: number, text: string }[]} */
            const pieces = [];
            res.setEncoding('utf8');
            res.on('data', (text) => pieces.push({ at: Date.now() - started, text }));
            res.on('end', () => resolve({
                status: res.statusCode, contentType: res.headers['content-type'] || null,
                body: pieces.map((p) => p.text).join(''), pieces,
            }));
        });
        req.on('error', (err) => resolve({ status: 0, error: String(err) }));
        req.end();
    });
}

async function main() {
    const app = express();
    app.use(buildApiProxy());
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const result = {
        extraCertificates: serverTls.hasExtraCertificates(),
        httpsAgentOptions: Object.keys(serverTls.httpsAgentOptions()),
        dispatcherReplaced: getGlobalDispatcher() !== before,
        fetch: {},
        proxy: {},
        stream: null,
    };
    for (const [name, url] of Object.entries(targets)) {
        result.fetch[name] = await viaFetch(url);
        // The API proxy targets Nextcloud's origin only when a Bee Flow server sits behind the same address.
        if (name === 'nextcloud' && !process.env.RUNNER_PROXY_NEXTCLOUD) continue;
        result.proxy[name] = await viaProxy(port, url, '/api/health');
    }
    if (targets.stream) result.stream = await viaProxy(port, targets.stream, '/api/chat/stream');

    process.stdout.write(`\nRESULT ${JSON.stringify(result)}\n`);
    server.closeAllConnections();
    server.close();
    process.exit(0);
}

main().catch((err) => {
    process.stdout.write(`\nRESULT ${JSON.stringify({ crashed: String(err && err.stack || err) })}\n`);
    process.exit(1);
});
