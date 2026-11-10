const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// scripts/harp-start.sh does its setup as root and then runs the connector as
// the unprivileged user. These tests run the real script with stub binaries
// on PATH (id, su-exec, chown, node) and look at what it finally executes.

const SCRIPT = path.join(__dirname, '..', 'scripts', 'harp-start.sh');

/** @param {{ uid?: string, env?: Record<string, string> }} [opts] */
function run({ uid = '0', env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harp-start-'));
    const bin = path.join(dir, 'bin');
    const storage = path.join(dir, 'data');
    const trace = path.join(dir, 'trace');
    fs.mkdirSync(bin);
    /** @param {string} name @param {string} body */
    const stub = (name, body) => {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub('id', `echo ${uid}`);
    stub('node', 'exit 0');
    stub('chown', `echo "chown $*" >> "${trace}"`);
    stub('su-exec', `echo "su-exec $*" >> "${trace}"`);
    stub('app', `echo "app $*" >> "${trace}"`);
    const result = spawnSync('bash', [SCRIPT, 'app', 'src/server.js'], {
        env: { PATH: `${bin}:/usr/bin:/bin`, APP_PERSISTENT_STORAGE: storage, ...env },
        encoding: 'utf8',
    });
    const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: result.status, lines, storage };
}

test('as root: the storage goes to the node user and the app runs through su-exec', () => {
    const { status, lines, storage } = run();
    assert.equal(status, 0);
    assert.ok(lines.includes(`chown -R node:node ${storage}`), lines.join('\n'));
    assert.equal(lines.at(-1), 'su-exec node app src/server.js');
    assert.ok(!lines.some(l => l.startsWith('app ')), 'the app must not start as root');
});

test('BEEFLOW_RUN_AS=root keeps the app on root', () => {
    const { lines } = run({ env: { BEEFLOW_RUN_AS: 'root' } });
    assert.deepEqual(lines, ['app src/server.js']);
});

test('already unprivileged: the app starts directly', () => {
    const { lines } = run({ uid: '1000' });
    assert.deepEqual(lines, ['app src/server.js']);
});
