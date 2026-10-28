// The webhook rows must follow a change of the public Nextcloud URL instead of
// piling up. Nextcloud's list filters `?uri=` by exact match, so rows created
// under the old address were invisible to the connector: every restart made a
// new set while the old one kept firing (double automation runs).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nextcloud';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const wl = require('../src/webhookListeners');
const { installFakeWorld, ocs } = require('./support/fakeWorld');

const OLD = 'http://nextcloud/index.php/apps/app_api/proxy/bee_flow/hooks/nextcloud';
const NEW_BASE = 'https://cloud.example.com';

function row(id, cls, uri, extra = {}) {
    return { id, event: cls, uri, appId: 'bee_flow', headers: { 'X-Beeflow-Hook-Event': 'x' }, ...extra };
}

function world(rows) {
    return installFakeWorld({
        nc: (method, url) => {
            if (method === 'GET' && url.includes('/webhook_listeners/api/v1/webhooks')) {
                assert.ok(!url.includes('uri='), 'the list must not be filtered by the (current) URI');
                return ocs(rows);
            }
            return undefined;
        },
    });
}

test.afterEach(() => wl.stopRetry());

test('rows registered under the old Nextcloud URL are updated in place, none are created', async () => {
    config.nextcloudPublicUrl = NEW_BASE;
    const rows = wl.EVENTS.map((e, i) => row(100 + i, e.class, OLD));
    const w = world(rows);
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(result.ok, true);
        const posts = w.calls.filter((c) => c.method === 'POST');
        assert.equal(posts.length, wl.EVENTS.length);
        assert.ok(posts.every((c) => /\/webhooks\/\d+$/.test(c.url)), 'every POST updates an existing row');
        assert.ok(posts.every((c) => JSON.parse(c.body).uri === `${NEW_BASE}/index.php/apps/app_api/proxy/bee_flow/hooks/nextcloud`));
        assert.equal(w.count((c) => c.method === 'DELETE'), 0);
    } finally {
        w.restore();
        config.nextcloudPublicUrl = null;
    }
});

test('duplicates and rows of a class we no longer register are deleted; other apps\' rows are left alone', async () => {
    const cls = wl.EVENTS[0].class;
    const rows = [
        row(1, cls, OLD),
        row(2, cls, OLD), // duplicate of the same class
        row(3, 'OCA\\Gone\\Event\\RemovedEvent', OLD), // a class we dropped
        { id: 4, event: cls, uri: 'https://elsewhere.test/hook', appId: 'other_app', headers: null }, // not ours
        { id: 5, event: cls, uri: 'http://nextcloud/index.php/apps/app_api/proxy/other_app/hooks/nextcloud', appId: 'other_app' },
    ];
    const w = world(rows);
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(result.removed, 2);
        const deleted = w.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort();
        assert.deepEqual(deleted, ['2', '3']);
        assert.ok(w.calls.some((c) => c.method === 'POST' && c.url.endsWith('/webhooks/1')));
    } finally {
        w.restore();
    }
});

test('two registrations side by side do not both create rows', async () => {
    let listed = 0;
    const w = installFakeWorld({
        nc: async (method, url) => {
            if (method === 'GET' && url.includes('/webhook_listeners/')) {
                listed++;
                await new Promise((r) => setTimeout(r, 20));
                return ocs([]);
            }
            return undefined;
        },
    });
    try {
        await Promise.all([wl.ensureWebhookListeners(), wl.ensureWebhookListeners()]);
        assert.equal(listed, 1);
        assert.equal(w.count((c) => c.method === 'POST'), wl.EVENTS.length);
    } finally {
        w.restore();
    }
});
