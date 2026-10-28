// The webhook list call must ride out the AppAPI warm-up 401 right after /init.
// withWarmupRetry only recognises that on a fetch Response, so the retry has to
// wrap the fetch itself, not the parsing around it.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const wl = require('../src/webhookListeners');

const WARMUP_BODY = JSON.stringify({ ocs: { meta: { status: 'failure', statuscode: 997, message: 'AppAPI authentication failed' } } });
const EMPTY_LIST = JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 200 }, data: [] } });

/** @param {Array<{status: number, body: string}>} script */
function stubFetch(script) {
    const real = globalThis.fetch;
    const calls = [];
    let listCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        if ((init.method || 'GET') === 'GET') {
            const step = script[Math.min(listCalls++, script.length - 1)];
            return new Response(step.body, { status: step.status });
        }
        return new Response('{}', { status: 200 });
    };
    return { calls, restore: () => { globalThis.fetch = real; }, listCalls: () => listCalls };
}

test('a 401 with the AppAPI 997 marker on the list call is retried, then registration proceeds', async () => {
    assert.ok(config.tenantKey);
    const stub = stubFetch([{ status: 401, body: WARMUP_BODY }, { status: 200, body: EMPTY_LIST }]);
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(stub.listCalls(), 2, 'the list was fetched a second time');
        assert.notEqual(result.reason, 'list-failed');
        assert.equal(result.ok, true);
        assert.ok(result.registered > 0);
    } finally {
        stub.restore();
        wl.stopRetry?.();
    }
});

test('a 404 on the list call still reports the webhook_listeners app as disabled, without retrying', async () => {
    const stub = stubFetch([{ status: 404, body: '{}' }]);
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(result.reason, 'app-disabled');
        assert.equal(stub.listCalls(), 1);
    } finally {
        stub.restore();
        wl.stopRetry?.();
    }
});
