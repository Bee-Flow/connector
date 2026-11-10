// A server chosen on the setup page stays the server after a restart, also
// when the admin settings form in Nextcloud names another one that nobody
// picked there.
//
// On the real process, twice on the same volume: src/server.js is booted in a
// child with support/netGuard.js observing every TCP connection. Nextcloud is
// a local HTTP server; a connection to any other address lands on a second
// local listener that stands in for every Bee Flow host and records the Host
// header it was asked for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
    listen, closeNow: close, freePort, until, fakeNextcloud, connectorEnv, forkConnector, request,
} = require('./support/connectorProcess');

const SECRET = 'restart-test-secret';
// A literal address, so no name is resolved; netGuard diverts the connection.
const OWN = 'http://192.0.2.10:3001';
const OWN_HOST = '192.0.2.10:3001';
const CLOUD_HOST = 'server.beeflow.nl:443';

/**
 * The listener every non-Nextcloud connection lands on. Over plain HTTP it
 * answers as a Bee Flow server that binds an instance once and gives that
 * binding up only to a signed bootstrap.
 */
async function beeFlowStandIn() {
    const bootstraps = [];
    let bound = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        const url = req.url || '';
        if (url.startsWith('/api/health')) return res.end(JSON.stringify({ status: 'ok' }));
        if (url.startsWith('/auth/connector/bootstrap')) {
            const signed = !!req.headers['x-beeflow-sig'];
            bootstraps.push({ host: req.headers.host, signed });
            if (bound > 0 && !signed) {
                res.statusCode = 403;
                return res.end(JSON.stringify({ error: 'already bound', code: 'NC_REBIND_PROOF_REQUIRED' }));
            }
            bound += 1;
            return res.end(JSON.stringify({ tenantKey: `key-${bound}`, organizationId: 'org-own', organizationName: 'Own' }));
        }
        return res.end('{}');
    });
    // A TLS handshake (a connection meant for an https host) is not HTTP.
    server.on('clientError', (_err, socket) => socket.destroy());
    const port = await listen(server);
    return { server, bootstraps, port };
}

const ADMIN = { 'AUTHORIZATION-APP-API': Buffer.from(`admin:${SECRET}`).toString('base64'), 'EX-APP-ID': 'bee_flow' };

/** Boot the connector on `storage`; resolves once it answers /heartbeat. */
async function boot(storage, nc, standIn) {
    const appPort = await freePort();
    const env = connectorEnv({ secret: SECRET, appPort, storage, nc, sinkPort: standIn.port }, { BEEFLOW_BOOTSTRAP_RETRY_MS: '0' });
    const { child, diverted, replies, errorOutput, stop } = forkConnector(env);
    await until(async () => {
        if (child.exitCode !== null) throw new Error(`the connector exited at boot:\n${errorOutput()}`);
        try { return (await request(appPort, 'GET', '/heartbeat')).status === 200; } catch { return false; }
    }, 'the connector answers /heartbeat');
    return {
        appPort,
        diverted,
        /** One more awaited round of what a start runs (bootstrap, init, the form poll, the menu sync). */
        async facts() {
            child.send('facts');
            await until(() => replies.length > 0, 'the facts of the connector process');
            const reply = replies.shift();
            assert.equal(reply.error, undefined, reply.error);
            return reply.facts;
        },
        stop,
    };
}

const keyOnDisk = (storage) => JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8')).tenantKey;

for (const formDelayMs of [0, 300]) {
    test(`the form names Bee Flow Cloud, an own server is chosen on the setup page: a restart changes nothing (form answered after ${formDelayMs} ms)`, async (t) => {
        const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-restart-'));
        const nc = await fakeNextcloud([{ configkey: 'deployment_mode', configvalue: 'cloud' }], { formOnTimer: true });
        const standIn = await beeFlowStandIn();
        /** @type {{ stop: () => Promise<void> }[]} */
        const running = [];
        t.after(async () => {
            for (const proc of running) await proc.stop();
            await close(nc.server);
            await close(standIn.server);
            fs.rmSync(storage, { recursive: true, force: true });
        });

        // ── First process: no server; the administrator chooses the own one ──
        const one = await boot(storage, nc, standIn);
        running.push(one);
        await until(() => nc.count('/ex-app/config/get-values') > 0, 'the form was read at the start');
        assert.equal((await one.facts()).apiBaseUrl, null);
        assert.deepEqual(one.diverted, [], 'nothing is sent before the choice');

        const save = await request(one.appPort, 'POST', '/setup', ADMIN, { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(save.status, 200, save.text);
        await until(async () => (await request(one.appPort, 'GET', '/setup/diagnostics', ADMIN)).json().hasTenantKey === true,
            'the connector is bound to the chosen server');
        const chosen = await one.facts(); // one more form poll, with the server chosen
        assert.equal(chosen.apiBaseUrl, OWN);
        assert.equal(chosen.tenantKey, 'key-1');
        assert.deepEqual([...new Set(one.diverted)], [OWN_HOST]);
        await one.stop();

        const adminReads = nc.count('/cloud/groups/admin/users');
        const formReads = nc.count('/ex-app/config/get-values');
        assert.deepEqual(standIn.bootstraps, [{ host: OWN_HOST, signed: false }]);

        // ── Second process: the same volume, nobody changed anything ─────────
        nc.state.formDelayMs = formDelayMs;
        const two = await boot(storage, nc, standIn);
        running.push(two);
        await until(() => nc.count('/ex-app/config/get-values') > formReads, 'the form was read at the second start');
        let after;
        for (let round = 0; round < 2; round++) after = await two.facts();

        assert.equal(after.apiBaseUrl, OWN);
        assert.equal(after.tenantKey, 'key-1');
        assert.equal(after.lastError, null);
        assert.equal(two.diverted.includes(CLOUD_HOST), false, 'no connection to the server the form names');
        assert.deepEqual(standIn.bootstraps, [{ host: OWN_HOST, signed: false }], 'the restart sent no bootstrap');
        assert.equal(nc.count('/cloud/groups/admin/users'), adminReads, 'the restart read no list of administrators');
        assert.equal(keyOnDisk(storage), 'key-1');
        const diagnostics = (await request(two.appPort, 'GET', '/setup/diagnostics', ADMIN)).json();
        assert.equal(diagnostics.apiBaseUrl, OWN);
        assert.equal(diagnostics.hasTenantKey, true);
    });
}
