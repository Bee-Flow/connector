// A webhook delivery as Nextcloud makes it for a row with a relative uri.
//
// For a row that has an app id and a uri starting with "/", Nextcloud's
// delivery job (apps/webhook_listeners/lib/BackgroundJobs/WebhookCall.php, the
// same on Nextcloud 33, 34 and 35) does not call an address: it hands the
// call to AppAPI (PublicFunctions::exAppRequest), which sends it to the ExApp
// the way it sends /init and /heartbeat, directly or through HaRP.
//
// `nextcloudDelivers` below builds that request from the row the connector
// itself registered, step by step as the two upstream functions do:
//
//   WebhookCall::run                    headers = row headers + authData headers
//                                       body    = json_encode(envelope), no Content-Type
//   AppAPIService::prepareRequestToExApp  url   = <ExApp base> + uri
//                                       headers += AA-VERSION, EX-APP-ID, EX-APP-VERSION,
//                                                  AUTHORIZATION-APP-API, AA-REQUEST-ID
//                                                  (AppAPI's win on a clash), Accept-Language
//                                       timeout = 3 seconds
//   HaRP (when the daemon is one)       path /exapps/<appid><uri> becomes <uri>,
//                                       AA-VERSION is set to "32", harp-shared-key is removed
//
// The connector's route runs for real behind the same middleware server.js
// puts in front of it; only the outbound network is replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

process.env.APP_SECRET = 'app-secret';
process.env.APP_VERSION = '2.0.0';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const rateLimit = require('../src/rateLimit');
const wl = require('../src/webhookListeners');
const hook = require('../src/automationEventsWebhook');
const { securityHeaders, rejectCrossSiteWrites } = require('../src/security');
const { installFakeWorld, ocs } = require('./support/fakeWorld');

const FORWARD_PATH = '/api/automation/events/nextcloud';
const NODE_CREATED = 'OCP\\Files\\Events\\Node\\NodeCreatedEvent';

let server;
let port;

test.before(async () => {
    config.ncInstanceId = 'inst-1';
    const app = express();
    // The order of server.js up to the hook route.
    app.use(securityHeaders);
    app.use(rejectCrossSiteWrites);
    app.use('/', hook);
    app.use((_req, res) => res.status(404).json({ error: 'not the hook route' }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
});
test.after(() => { if (server) server.close(); });
test.beforeEach(() => rateLimit.reset());
test.afterEach(() => { wl.stopRetry(); hook._setAnswerWithinMsForTests(2_000); });

/**
 * The outbound network: a Nextcloud that keeps webhook rows as
 * WebhooksController does (the app id of a row is the EX-APP-ID of the AppAPI
 * call that wrote it), and the chosen Bee Flow server.
 * @param {{ forwardDelayMs?: number }} [opts]
 */
function world({ forwardDelayMs = 0 } = {}) {
    const rows = [];
    const forwarded = [];
    let nextId = 1;
    const w = installFakeWorld({
        servers: {
            [config.apiBaseUrl]: {
                [`POST ${FORWARD_PATH}`]: async (init) => {
                    if (forwardDelayMs) await new Promise((resolve) => setTimeout(resolve, forwardDelayMs));
                    forwarded.push({ headers: init.headers, body: String(init.body) });
                    return { ok: true };
                },
            },
        },
        nc: (method, url, init) => {
            if (method === 'PROPFIND') {
                return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
            }
            if (!url.includes('/webhook_listeners/api/v1/webhooks')) return undefined;
            if (method === 'GET') return ocs(rows);
            const body = JSON.parse(String(init.body));
            const saved = { id: nextId++, appId: init.headers['EX-APP-ID'] || null, ...body };
            rows.push(saved);
            return ocs(saved);
        },
    });
    return { rows, forwarded, restore: w.restore };
}

/**
 * Nextcloud delivering one event for a registered row. Resolves with the
 * ExApp's answer and the request as it was sent.
 * @param {object} row       a row as Nextcloud stores it
 * @param {object} envelope  { event, user, time }
 * @param {{ harp?: boolean, withoutAuthData?: boolean, authData?: Record<string, string> }} [opts]
 */
function nextcloudDelivers(row, envelope, { harp = false, withoutAuthData = false, authData } = {}) {
    // WebhookCall::run takes the AppAPI branch only for such a row.
    assert.ok(row.appId, 'the row carries an app id');
    assert.ok(row.uri.startsWith('/'), 'the row has a relative uri');
    assert.equal(row.authMethod, 'header');

    const triggerUid = envelope.user?.uid ?? null;
    let headers = { ...(row.headers || {}) };
    if (!withoutAuthData) headers = { ...headers, ...(authData || row.authData) };
    headers = {
        ...headers,
        'AA-VERSION': '35.0.0',
        'EX-APP-ID': row.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`${triggerUid ?? ''}:${config.appSecret}`).toString('base64'),
        'AA-REQUEST-ID': 'CLI',
    };
    if (harp) {
        headers['ex-app-port'] = '23000';
        headers['ex-app-host'] = 'nc_app_bee_flow';
        headers['AA-VERSION'] = '32';
    }
    headers['Accept-Language'] = 'en';
    headers['User-Agent'] = 'Nextcloud-Server-Crawler/35.0.0';
    const body = JSON.stringify({ ...envelope, authentication: [] });
    headers['Content-Length'] = String(Buffer.byteLength(body));
    assert.ok(!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type'), 'the delivery names no Content-Type');

    const started = Date.now();
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: row.httpMethod, path: row.uri, headers, timeout: 3_000 }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, ms: Date.now() - started, sent: headers }));
        });
        req.on('timeout', () => req.destroy(new Error('AppAPI gave up after 3 seconds')));
        req.on('error', reject);
        req.end(body);
    });
}

/** Register and return the row of one event class. */
async function registeredRow(w, cls = NODE_CREATED) {
    const result = await wl.ensureWebhookListeners();
    assert.equal(result.ok, true);
    const row = w.rows.find((r) => r.event === cls);
    assert.ok(row, `a row for ${cls}`);
    return row;
}

const created = (uid = 'alice') => ({
    event: { class: NODE_CREATED, node: { id: 437, path: `/${uid}/files/Reports/q3.pdf` } },
    user: { uid, displayName: 'Alice' },
    time: 1770000000,
});

function assertSignedForward(sent) {
    const [ts, sig] = sent.headers['X-Beeflow-Sig'].split('.');
    const expected = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nPOST\n${FORWARD_PATH}\n${sent.body}`).digest('hex');
    assert.equal(sig, expected, 'signed with the tenant key over the body');
    assert.equal(sent.headers['X-Beeflow-NC-Instance-Id'], 'inst-1');
}

test('the registered row is one Nextcloud delivers through AppAPI', async () => {
    const w = world();
    try {
        const row = await registeredRow(w);
        assert.equal(row.uri, '/hooks/nextcloud');
        assert.equal(row.appId, config.appId);
        assert.equal(row.httpMethod, 'POST');
        assert.deepEqual(row.authData, { 'X-Beeflow-Hook-Secret': wl.hookSecret() });
        assert.equal(row.headers['X-Beeflow-Hook-Event'], 'file.new');
        assert.equal(row.tokenNeeded, undefined, 'no user tokens are asked for');
        assert.ok(w.rows.every((r) => r.uri === '/hooks/nextcloud' && r.appId === config.appId));
    } finally {
        w.restore();
    }
});

for (const harp of [false, true]) {
    const channel = harp ? 'through HaRP' : 'straight from AppAPI';
    test(`a delivery ${channel} is accepted, read without a Content-Type and forwarded signed`, async () => {
        const w = world();
        try {
            const row = await registeredRow(w);
            const res = await nextcloudDelivers(row, created(), { harp });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { ok: true, event: 'file.new', events: ['file.new'] });

            assert.equal(w.forwarded.length, 1);
            const body = JSON.parse(w.forwarded[0].body);
            assert.equal(body.event, 'file.new');
            assert.equal(body.ncUid, 'alice');
            assert.equal(body.payload.path, '/Reports/q3.pdf');
            assert.equal(body.payload.owner, 'alice');
            assert.equal(body.payload.nodeType, 'file');
            assert.ok(!('authentication' in body) && !('authentication' in body.payload));
            assertSignedForward(w.forwarded[0]);
        } finally {
            w.restore();
        }
    });
}

test('a delivery for an event without a user is accepted (AppAPI sends an empty user id)', async () => {
    const w = world();
    try {
        const row = await registeredRow(w);
        const envelope = { ...created(), user: null };
        const res = await nextcloudDelivers(row, envelope);
        assert.equal(Buffer.from(res.sent['AUTHORIZATION-APP-API'], 'base64').toString(), `:${config.appSecret}`);
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(w.forwarded[0].body).ncUid, null);
    } finally {
        w.restore();
    }
});

test('the secret from the row is what opens the route: AppAPI\'s own headers do not', async () => {
    const w = world();
    try {
        const row = await registeredRow(w);
        const without = await nextcloudDelivers(row, created(), { withoutAuthData: true });
        assert.equal(without.status, 401);
        const wrong = await nextcloudDelivers(row, created(), { authData: { 'X-Beeflow-Hook-Secret': 'f'.repeat(64) } });
        assert.equal(wrong.status, 401);
        // The tenant key itself is not the secret.
        const key = await nextcloudDelivers(row, created(), { authData: { 'X-Beeflow-Hook-Secret': config.tenantKey } });
        assert.equal(key.status, 401);
        assert.equal(w.forwarded.length, 0, 'nothing is forwarded for a refused delivery');
    } finally {
        w.restore();
    }
});

test('a refused delivery is answered before its body is read', async () => {
    const w = world();
    try {
        const row = await registeredRow(w);
        // Not JSON: a delivery with the secret gets 400 from the parser, one without gets 401.
        const send = (headers) => new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: row.uri, headers }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject);
            req.end('{not json');
        });
        assert.equal(await send({}), 401);
        assert.equal(await send(row.authData), 400);
    } finally {
        w.restore();
    }
});

test('the answer does not wait for a slow Bee Flow server: it comes inside AppAPI\'s 3 seconds', async () => {
    hook._setAnswerWithinMsForTests(80);
    const w = world({ forwardDelayMs: 400 });
    try {
        const row = await registeredRow(w);
        const res = await nextcloudDelivers(row, created());
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true, event: 'file.new', events: ['file.new'] });
        assert.ok(res.ms < 350, `answered after ${res.ms} ms, before the forward finished`);
        assert.equal(w.forwarded.length, 0);
        // The forward still completes.
        const deadline = Date.now() + 3_000;
        while (w.forwarded.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(w.forwarded.length, 1);
        assertSignedForward(w.forwarded[0]);
    } finally {
        w.restore();
    }
});

test('the default leaves a second of margin under AppAPI\'s timeout', async () => {
    // A forward that takes longer than AppAPI waits: answered at about 2 seconds.
    const w = world({ forwardDelayMs: 2_600 });
    try {
        const row = await registeredRow(w);
        const res = await nextcloudDelivers(row, created());
        assert.equal(res.status, 200);
        assert.ok(res.ms >= 1_900 && res.ms < 2_500, `answered after ${res.ms} ms`);
        const deadline = Date.now() + 3_000;
        while (w.forwarded.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(w.forwarded.length, 1);
    } finally {
        w.restore();
    }
});

test('setup/diagnostics reports the last delivery since the connector started', async () => {
    const setupRouter = require('../src/setup');
    const realFetch = globalThis.fetch;
    const diagnostics = async () => {
        const app = express();
        app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true, language: null } }; next(); });
        app.use('/setup', setupRouter);
        const s = app.listen(0);
        try {
            await new Promise((resolve) => s.once('listening', resolve));
            const res = await realFetch(`http://127.0.0.1:${s.address().port}/setup/diagnostics`);
            assert.equal(res.status, 200);
            return (await res.json()).webhooks;
        } finally {
            s.close();
        }
    };

    const before = await diagnostics();
    assert.ok(!Number.isNaN(Date.parse(before.since)), 'since: when this connector process started');
    assert.equal(typeof before.deliveries, 'number');

    const w = world();
    try {
        const row = await registeredRow(w);
        const beforeDelivery = Date.now();
        await nextcloudDelivers(row, created(), { withoutAuthData: true }); // refused: not a delivery
        assert.equal(hook.deliveryStats().deliveries, before.deliveries);
        await nextcloudDelivers(row, created());
        // A class the connector no longer maps is still a delivery that arrived.
        await nextcloudDelivers(row, { event: { class: 'OCA\\Gone\\Event\\RemovedEvent' }, user: null, time: 1 });
        const after = hook.deliveryStats();
        assert.equal(after.deliveries, before.deliveries + 2);
        assert.equal(after.since, before.since);
        assert.ok(Date.parse(after.lastDeliveryAt) >= beforeDelivery);
        assert.ok(Date.parse(after.lastDeliveryAt) >= Date.parse(after.since));
        assert.equal(wl.isRegistered(), true);
    } finally {
        w.restore();
    }
    const shown = await diagnostics();
    assert.deepEqual(Object.keys(shown).sort(), ['deliveries', 'forwarded', 'lastDeliveryAt', 'lastForwardedAt', 'registered', 'since']);
    // What the Bee Flow server accepted is counted apart from what arrived:
    // of the two deliveries one is of a class that is not forwarded.
    assert.equal(shown.forwarded, before.forwarded + 1);
    assert.ok(Date.parse(shown.lastForwardedAt) >= Date.parse(shown.since));
    assert.equal(shown.registered, true);
    assert.equal(shown.deliveries, before.deliveries + 2);
    assert.equal(shown.lastDeliveryAt, hook.deliveryStats().lastDeliveryAt);
});

test('before any delivery the last delivery is null, not a time', () => {
    // A fresh process: the module state as it is at load.
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `
        process.env.APP_SECRET = 's'; process.env.NEXTCLOUD_URL = 'http://nc.test';
        const hook = require(${JSON.stringify(require.resolve('../src/automationEventsWebhook'))});
        const wl = require(${JSON.stringify(require.resolve('../src/webhookListeners'))});
        process.stdout.write(JSON.stringify({ ...hook.deliveryStats(), registered: wl.isRegistered() }));
    `], { encoding: 'utf8' });
    const stats = JSON.parse(out);
    assert.equal(stats.deliveries, 0);
    assert.equal(stats.lastDeliveryAt, null);
    assert.equal(stats.registered, false);
});
