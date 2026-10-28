// A container stop must leave every Nextcloud registration in place. The Talk
// bot above all: Talk removes the bot from every conversation when its row is
// deleted, so a teardown on SIGTERM emptied all rooms on each restart.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const { createShutdownHandler } = require('../src/shutdown');

test('SIGTERM exits without a single call to Nextcloud', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push(`${init?.method || 'GET'} ${url}`);
        return new Response('{}', { status: 200 });
    });
    const exits = [];
    const shutdown = createShutdownHandler({ exit: (code) => exits.push(code) });
    shutdown('SIGTERM');
    shutdown('SIGINT'); // a second signal is ignored
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(exits, [0]);
    assert.deepEqual(calls, [], 'no DELETE of the Talk bot, webhooks, task providers or file actions');
});
