// What serverTls.test.js and serverProxy.test.js share: the stand-in server
// their listeners run, the bookkeeping of those listeners, and the child
// process (egressRunner.js) that loads the connector with one combination of
// install-time values.

const path = require('node:path');
const { execFile } = require('node:child_process');

// Values of the developer's or CI's shell that would change what the child does.
const INHERITED = ['BEEFLOW_NC_CA_FILE', 'BEEFLOW_NC_TLS_INSECURE', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

/** A stand-in for either server: /api/health, and an event stream in two pieces 300 ms apart. */
function standIn(req, res) {
    if (req.url === '/api/chat/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 300);
        return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', path: req.url }));
}

/** The listeners of one test file: `listen` starts one on a free port, `closeAll` ends them. */
function listeners() {
    /** @type {import('node:net').Server[]} */
    const servers = [];
    return {
        async listen(server) {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            servers.push(server);
            return server.address().port;
        },
        async closeAll() {
            for (const server of servers) {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        },
    };
}

/**
 * Run the connector's clients in a process of their own with these install-time
 * values. A name in INHERITED or `alsoCleared` that `env` does not set is
 * removed from the child's environment.
 * @param {Record<string, string>} env
 * @param {Record<string, string>} targets  name → URL (RUNNER_TARGETS)
 * @param {string[]} [alsoCleared]
 */
function runEgress(env, targets, alsoCleared = []) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...process.env, ...env, RUNNER_TARGETS: JSON.stringify(targets) };
        for (const name of [...INHERITED, ...alsoCleared]) {
            if (!(name in env)) delete childEnv[name];
        }
        execFile(process.execPath, [path.join(__dirname, 'egressRunner.js')], { env: childEnv, timeout: 30_000 },
            (err, stdout, stderr) => {
                const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
                if (!line) return reject(new Error(`runner gave no result: ${err || ''}\n${stdout}\n${stderr}`));
                return resolve({ ...JSON.parse(line.slice(7)), log: `${stdout}\n${stderr}` });
            });
    });
}

module.exports = { standIn, listeners, runEgress };
