// The pieces of a test that boots the real connector (src/server.js) in a child
// process with netGuard.js preloaded: local listeners, a Nextcloud that answers
// the OCS calls the connector makes, the child's environment, the fork itself
// and plain-http requests to it.
//
//   const nc = await fakeNextcloud(form);
//   const appPort = await freePort();
//   const proc = forkConnector(connectorEnv({ secret, appPort, storage, nc, sinkPort }));
//   ...
//   await proc.stop();

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { fork } = require('node:child_process');

const RUNNER = path.join(__dirname, 'noServerRunner.js');
const NET_GUARD = path.join(__dirname, 'netGuard.js');

/** Listen on a free local port; resolves with that port. */
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
/** Close a listener once its connections have ended. */
const close = (server) => new Promise((resolve) => server.close(resolve));
/** Close a listener and the connections it still holds. */
const closeNow = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

async function freePort() {
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    return port;
}

/** The body of an OCS success answer. */
const ocsBody = (data) => JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 200 }, data } });

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, what, ms = 15_000) {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error(`not reached in time: ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Every file in a directory with its content and modification time. */
function snapshot(dir) {
    return fs.readdirSync(dir).sort().map((name) => {
        const file = path.join(dir, name);
        return { name, content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
    });
}

/**
 * A Nextcloud that answers the OCS calls the connector makes, and records each
 * one. Its settings form holds `form`. With `formOnTimer` the form is answered
 * from a timer of `state.formDelayMs` milliseconds, which a test may raise.
 * @param {object[]} [form]
 * @param {{ formOnTimer?: boolean }} [opts]
 */
async function fakeNextcloud(form = [], { formOnTimer = false } = {}) {
    /** @type {{ method: string, url: string }[]} */
    const calls = [];
    const state = { formDelayMs: 0 };
    const server = http.createServer((req, res) => {
        const url = req.url || '';
        calls.push({ method: req.method, url });
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        if (url.includes('/cloud/capabilities')) {
            return res.end(ocsBody({ version: { string: '34.0.0' }, capabilities: { theming: { name: 'NC', instanceid: 'inst-1' } } }));
        }
        if (url.includes('/cloud/groups/admin/users')) return res.end(ocsBody({ users: ['admin'] }));
        if (url.includes('/ex-app/config/get-values')) {
            if (formOnTimer) return void setTimeout(() => res.end(ocsBody(form)), state.formDelayMs);
            return res.end(ocsBody(form));
        }
        const user = /\/cloud\/users\/([^?/]+)/.exec(url);
        if (user) {
            const uid = decodeURIComponent(user[1]);
            return res.end(ocsBody({
                id: uid, email: `${uid}@nc.test`, displayname: uid, groups: uid === 'admin' ? ['admin'] : ['users'],
            }));
        }
        return res.end(ocsBody([]));
    });
    const port = await listen(server);
    return {
        server, calls, state, port, url: `http://127.0.0.1:${port}`,
        /** How many calls had this text in their URL. */
        count: (part) => calls.filter((c) => c.url.includes(part)).length,
    };
}

/**
 * A clean environment for the child: nothing of the developer's or CI's shell
 * reaches it. Connections to Nextcloud pass netGuard, every other one lands on
 * `sinkPort`. `extra` holds what differs per test.
 * @param {{ secret: string, appPort: number, storage: string, nc: { url: string, port: number }, sinkPort: number }} install
 * @param {Record<string, string>} [extra]
 */
function connectorEnv({ secret, appPort, storage, nc, sinkPort }, extra = {}) {
    return {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        APP_ID: 'bee_flow',
        APP_SECRET: secret,
        APP_VERSION: '2.0.0-test',
        APP_PORT: String(appPort),
        APP_PERSISTENT_STORAGE: storage,
        NEXTCLOUD_URL: nc.url,
        NETGUARD_ALLOW: `127.0.0.1:${nc.port}`,
        NETGUARD_SINK: `127.0.0.1:${sinkPort}`,
        ...extra,
    };
}

/**
 * Boot the connector in a child. `diverted` collects the addresses netGuard
 * sent to the sink, `replies` every other message of the child.
 * @param {Record<string, string | undefined>} env
 * @param {{ stderr?: 'pipe' | 'ignore' }} [opts]
 */
function forkConnector(env, { stderr = 'pipe' } = {}) {
    const child = fork(RUNNER, [], { env, execArgv: ['--require', NET_GUARD], stdio: ['ignore', 'ignore', stderr, 'ipc'] });
    let errorOutput = '';
    child.stderr?.on('data', (d) => { errorOutput += d; });
    /** @type {string[]} */
    const diverted = [];
    /** @type {any[]} */
    const replies = [];
    child.on('message', (/** @type {any} */ m) => {
        if (m.diverted) diverted.push(m.diverted);
        else replies.push(m);
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    return {
        child, diverted, replies,
        /** What the child wrote to stderr so far (with `stderr: 'pipe'`). */
        errorOutput: () => errorOutput,
        async stop() {
            child.kill('SIGKILL');
            await exited;
        },
    };
}

/**
 * One request to the connector, the way a browser behind Nextcloud's proxy
 * sends it. Plain http, so the test decides every header (fetch sets
 * Sec-Fetch-Mode itself).
 * @returns {Promise<{ status: number, ok: boolean, headers: import('node:http').IncomingHttpHeaders, text: string, json: () => any }>}
 */
function request(port, method, p, headers = {}, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, method, path: p, agent: false,
            headers: { ...headers, ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { text += d; });
            res.on('end', () => resolve({
                status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
                headers: res.headers, text, json: () => JSON.parse(text),
            }));
        });
        req.on('error', reject);
        req.end(payload === null ? undefined : payload);
    });
}

/** The headers AppAPI adds for this user. */
const appApiHeaders = (uid, secret) => ({ 'AUTHORIZATION-APP-API': Buffer.from(`${uid}:${secret}`).toString('base64'), 'EX-APP-ID': 'bee_flow' });

module.exports = {
    listen, close, closeNow, freePort, until, snapshot, fakeNextcloud, connectorEnv, forkConnector, request, appApiHeaders,
};
