// One webhook row per event class, whatever uri the rows carry. A row of ours
// has the relative uri (delivered through AppAPI) or an absolute Nextcloud
// address (from a connector before 2.0, or under an earlier public Nextcloud
// URL). A registration pass finds both, rewrites each class's row in place to
// the relative uri and removes what is left over, so no event fires twice.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nextcloud';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const wl = require('../src/webhookListeners');
const { installFakeWorld, ocs } = require('./support/fakeWorld');

const OLD = 'http://nextcloud/index.php/apps/app_api/proxy/bee_flow/hooks/nextcloud';
const OLDER = 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow/hooks/nextcloud';
const RELATIVE = '/hooks/nextcloud';

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

test('rows registered with an absolute Nextcloud address are updated in place, none are created', async () => {
    config.nextcloudPublicUrl = 'https://cloud.example.com';
    const rows = wl.EVENTS.map((e, i) => row(100 + i, e.class, i % 2 ? OLD : OLDER));
    const w = world(rows);
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(result.ok, true);
        const posts = w.calls.filter((c) => c.method === 'POST');
        assert.equal(posts.length, wl.EVENTS.length);
        assert.ok(posts.every((c) => /\/webhooks\/\d+$/.test(c.url)), 'every POST updates an existing row');
        assert.ok(posts.every((c) => JSON.parse(c.body).uri === RELATIVE), 'every row now has the relative uri');
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

/**
 * A Nextcloud that keeps webhook rows the way WebhooksController does: the
 * app id of a row is the EX-APP-ID of the AppAPI call that wrote it, and the
 * answer to a create or update is the row.
 * @param {object[]} rows
 * @param {{ recordsAppId?: boolean }} [opts]
 */
function nextcloudWithRows(rows, { recordsAppId = true } = {}) {
    let nextId = 1000;
    const w = installFakeWorld({
        nc: (method, url, init) => {
            if (!url.includes('/webhook_listeners/api/v1/webhooks')) return undefined;
            const id = (url.match(/\/webhooks\/(\d+)$/) || [])[1];
            if (method === 'GET') return ocs(rows);
            if (method === 'DELETE') {
                rows.splice(rows.findIndex((r) => String(r.id) === id), 1);
                return ocs(true);
            }
            const body = JSON.parse(String(init.body));
            const saved = {
                id: id ? Number(id) : nextId++,
                appId: recordsAppId ? init.headers['EX-APP-ID'] : null,
                uri: body.uri, event: body.event, headers: body.headers,
            };
            const at = rows.findIndex((r) => String(r.id) === id);
            if (at >= 0) rows[at] = saved; else rows.push(saved);
            return ocs(saved);
        },
    });
    return w;
}

test('a mix of absolute and relative rows ends as one relative row per class, registered once', async () => {
    const [a, b, c, d, ...rest] = wl.EVENTS.map((e) => e.class);
    const rows = [
        row(1, a, OLD), // absolute only: rewritten in place
        row(2, b, RELATIVE), // relative only: kept
        row(3, c, OLD), // both forms for one class: the relative row is kept ...
        row(4, c, RELATIVE),
        row(5, d, RELATIVE), // ... whatever the order in the list
        row(6, d, OLDER),
        row(7, 'OCA\\Gone\\Event\\RemovedEvent', RELATIVE), // a class we dropped
        { id: 8, event: a, uri: RELATIVE, appId: 'other_app', headers: { 'X-Other': '1' } }, // another ExApp's row
        { id: 9, event: a, uri: RELATIVE, appId: 'other_app', headers: { 'X-Beeflow-Hook-Event': 'x' } },
        { id: 10, event: a, uri: 'https://elsewhere.test/hooks/nextcloud', appId: null, headers: null },
    ];
    const w = nextcloudWithRows(rows);
    try {
        const first = await wl.ensureWebhookListeners();
        assert.equal(first.ok, true);
        const posts = w.calls.filter((call) => call.method === 'POST');
        assert.equal(posts.length, wl.EVENTS.length, 'one write per class');
        assert.ok(posts.every((call) => JSON.parse(call.body).uri === RELATIVE));
        const updated = posts.map((call) => (call.url.match(/\/webhooks\/(\d+)$/) || [])[1]).filter(Boolean).sort();
        assert.deepEqual(updated, ['1', '2', '4', '5'], 'a class with a row is updated in place');
        assert.equal(posts.filter((call) => call.url.endsWith('/webhooks')).length, rest.length, 'only classes without a row get one');
        const deleted = w.calls.filter((call) => call.method === 'DELETE').map((call) => call.url.split('/').pop()).sort();
        assert.deepEqual(deleted, ['3', '6', '7']);

        const ours = rows.filter((r) => r.appId === 'bee_flow');
        assert.equal(ours.length, wl.EVENTS.length);
        assert.equal(new Set(ours.map((r) => r.event)).size, wl.EVENTS.length, 'one row per class');
        assert.ok(ours.every((r) => r.uri === RELATIVE));
        assert.deepEqual(rows.filter((r) => r.appId !== 'bee_flow').map((r) => r.id), [8, 9, 10], 'rows of others are untouched');

        // A second pass changes nothing: every class is found again.
        const before = w.calls.length;
        await wl.ensureWebhookListeners();
        const again = w.calls.slice(before);
        assert.equal(again.filter((call) => call.method === 'POST' && call.url.endsWith('/webhooks')).length, 0, 'nothing is created');
        assert.equal(again.filter((call) => call.method === 'DELETE').length, 0);
        assert.equal(rows.filter((r) => r.appId === 'bee_flow').length, wl.EVENTS.length);
    } finally {
        w.restore();
    }
});

test('a row Nextcloud records no app id on gets the absolute address, and is found again', async () => {
    // Nextcloud delivers a relative uri through AppAPI only for a row with an
    // app id; without one the row needs an address Nextcloud can call.
    const rows = [];
    const w = nextcloudWithRows(rows, { recordsAppId: false });
    try {
        const result = await wl.ensureWebhookListeners();
        assert.equal(result.ok, true);
        assert.equal(rows.length, wl.EVENTS.length);
        assert.ok(rows.every((r) => r.uri === wl.absoluteHookUri()));
        await wl.ensureWebhookListeners();
        assert.equal(rows.length, wl.EVENTS.length, 'the second pass creates nothing');
        assert.ok(rows.every((r) => r.uri === wl.absoluteHookUri()));
    } finally {
        w.restore();
    }
});
