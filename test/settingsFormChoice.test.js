// The admin settings form (Nextcloud → Administration → Artificial
// Intelligence) and the choice of a Bee Flow server.
//
// The form does not choose by itself. Its default is "No change". While no
// server is chosen, the values Nextcloud holds at the first poll after a start
// are only noted; the form counts as a choice once it names another server,
// and a noted server stays without effect after a choice on the setup page and
// after a restart. A first choice asks the address for /api/health before
// anything is saved or sent.
//
// The poll, the bootstrap and the setup route run for real; only the network
// is replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLOUD = 'https://server.beeflow.nl';
const OWN = 'https://bee-flow.example';
const NC = 'http://nc.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-settings-form-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = NC;
process.env.BEEFLOW_TENANT_KEY = 'auto';
delete process.env.BEEFLOW_API_BASE_URL; // nothing chosen at install time
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const { installFakeWorld, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');
const declarativeSettings = require('../src/declarativeSettings');

const HEALTHY = { 'GET /api/health': () => ({ status: 'ok' }) };
const BINDS = (tenantKey) => ({ ...HEALTHY, 'POST /auth/connector/bootstrap': () => ({ tenantKey, organizationId: `org-${tenantKey}` }) });
const CLOUD_FORM = [{ configkey: 'deployment_mode', configvalue: 'cloud' }];
const OWN_FORM = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: OWN }];
const KEEP_FORM = [{ configkey: 'deployment_mode', configvalue: 'keep' }];

/** The connector right after a start: what is on disk decides the server. */
function start(files = {}) {
    setupConfig.init(storage);
    setupConfig.clear();
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(storage, name), JSON.stringify(content));
    return restart();
}

/** The same volume, a new process: only what is on disk carries over. */
function restart() {
    const choice = serverChoice.applyAtBoot(config, setupConfig.init(storage));
    config.organizationId = null;
    config.organizationName = null;
    config.ncInstanceId = null;
    config.pairingCode = null;
    declarativeSettings._resetForTests();
    return choice;
}

/** What POST /setup does with a choice that passed its checks. */
async function chooseOnSetupPage(mode, apiBaseUrl) {
    const saved = setupConfig.save({ mode, apiBaseUrl, embedBaseUrl: null });
    await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: saved.apiBaseUrl });
}

/**
 * A world in which Nextcloud holds `form.values` for the settings form.
 * @param {Record<string, Record<string, Function>>} servers
 */
function worldWith(servers, form) {
    return installFakeWorld({
        servers,
        nc: (_method, url) => (url.includes('/ex-app/config/get-values') ? ocs(form.values) : undefined),
    });
}

const poll = () => declarativeSettings.applyStoredValuesIfChanged();
const outsideNextcloud = (world) => world.calls.filter((c) => !c.url.startsWith(`${NC}/`)).map((c) => `${c.method} ${c.url}`);
const adminReads = (world) => world.count((c) => c.url.includes('/cloud/groups/admin/users'));

test.after(() => {
    declarativeSettings.stopPolling();
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

for (const [what, values] of [['Bee Flow Cloud', CLOUD_FORM], ['an own server', OWN_FORM]]) {
    test(`no server chosen, the form already holds ${what} at the start: poll after poll, nothing is sent`, async () => {
        assert.equal(start().source, 'none');
        const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, { values });
        try {
            for (let i = 0; i < 5; i++) await poll();

            assert.deepEqual(outsideNextcloud(world), [], 'no request to any Bee Flow host, not even /api/health');
            assert.equal(world.count((c) => c.url.includes('/ex-app/config/get-values')), 5, 'the form was read each time');
            assert.equal(adminReads(world), 0, 'the administrators are not read');
            assert.equal(config.apiBaseUrl, null);
            assert.equal(config.tenantKey, null);
            assert.equal(setupConfig.get(), null);
            assert.deepEqual(fs.readdirSync(storage), [], 'no file written');
            assert.equal(bootstrap._bootstrapRetryArmedForTests(), false);

            // The same after another start: the value is still not a choice.
            assert.equal(start().source, 'none');
            for (let i = 0; i < 3; i++) await poll();
            assert.deepEqual(outsideNextcloud(world), []);
            assert.equal(config.apiBaseUrl, null);
        } finally {
            world.restore();
        }
    });
}

test('a value changed after the start is a choice: the address is asked first, then the connector binds', async () => {
    start();
    const form = { values: [] };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key') }, form);
    try {
        await poll();
        await poll();
        assert.deepEqual(outsideNextcloud(world), []);

        form.values = CLOUD_FORM; // the administrator picks Bee Flow Cloud
        await poll();
        assert.equal(config.apiBaseUrl, CLOUD);
        assert.equal(config.tenantKey, 'cloud-key');
        assert.equal(setupConfig.get()?.mode, 'cloud');
        assert.equal(config.serverSource, 'picker');

        const outside = outsideNextcloud(world);
        assert.equal(outside[0], `GET ${CLOUD}/api/health`, 'the first request outside Nextcloud');
        const probe = world.calls.find((c) => c.url === `${CLOUD}/api/health`);
        assert.equal(probe.body, null);
        assert.deepEqual(probe.headers, {});
        const order = world.calls.map((c) => c.url);
        assert.ok(order.findIndex((u) => u.includes('/cloud/groups/admin/users')) > order.indexOf(`${CLOUD}/api/health`),
            'the administrators are read after the server answered');

        await poll();
        await poll();
        assert.equal(world.count((c) => c.url === `${CLOUD}/auth/connector/bootstrap`), 1, 'applied once');
    } finally {
        world.restore();
    }
});

test('a value noted at the start and changed later is a choice like any other', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        form.values = OWN_FORM;
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(CLOUD)), [], 'nothing went to the noted value');
    } finally {
        world.restore();
    }
});

test('a first choice at an address where no Bee Flow server answers: nothing saved, nothing sent, asked again later', async () => {
    start();
    const form = { values: [] };
    let up = false;
    const world = worldWith({
        [OWN]: {
            'GET /api/health': () => { if (!up) throw new TypeError('fetch failed'); return { status: 'ok' }; },
            'POST /auth/connector/bootstrap': () => ({ tenantKey: 'own-key', organizationId: 'org-own' }),
        },
    }, form);
    try {
        await poll();
        form.values = OWN_FORM;
        await poll();
        await poll();
        assert.deepEqual(outsideNextcloud(world), [`GET ${OWN}/api/health`, `GET ${OWN}/api/health`]);
        assert.equal(adminReads(world), 0);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
        assert.deepEqual(fs.readdirSync(storage), []);

        up = true; // the server is started
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
    } finally {
        world.restore();
    }
});

test('"No change" asks for nothing, with or without a server', async () => {
    start();
    const form = { values: [] };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        form.values = KEEP_FORM;
        await poll();
        // Also with an address left in the field next to it.
        form.values = [...KEEP_FORM, { configkey: 'api_base_url', configvalue: OWN }];
        await poll();
        assert.deepEqual(outsideNextcloud(world), []);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);

        // Connected to an own server; the form on "No change" leaves it there.
        start({ 'tenant-key.json': { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN } });
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, OWN);
        form.values = KEEP_FORM;
        await poll();
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world), []);
    } finally {
        world.restore();
    }
});

test('a value noted at the start does not move a server chosen on the setup page', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll(); // notes "Cloud"
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }); // the choice on the setup page
        assert.equal(config.apiBaseUrl, OWN);

        // Another field of the form changes; the server fields do not.
        form.values = [...CLOUD_FORM, { configkey: 'web_app_url', configvalue: 'https://app.bee-flow.example' }];
        for (let i = 0; i < 3; i++) await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(CLOUD)), [], 'nothing went to the noted value');
    } finally {
        world.restore();
    }
});

test('a failed read of the form at the start does not make the next one a choice', async () => {
    start();
    let fail = true;
    const real = installFakeWorld({
        servers: { [CLOUD]: BINDS('cloud-key') },
        nc: (_method, url) => {
            if (!url.includes('/ex-app/config/get-values')) return undefined;
            return fail ? new Response('down', { status: 503 }) : ocs(CLOUD_FORM);
        },
    });
    try {
        await poll(); // Nextcloud is still starting
        fail = false;
        for (let i = 0; i < 3; i++) await poll();
        assert.deepEqual(outsideNextcloud(real), []);
        assert.equal(config.apiBaseUrl, null);
    } finally {
        real.restore();
    }
});

test('an install that is connected follows the form as before, without a question first', async () => {
    assert.equal(start({
        'tenant-key.json': { tenantKey: 'cloud-key', organizationId: 'org-cloud', ncInstanceId: 'inst-1', boundApiBaseUrl: CLOUD },
    }).source, 'binding');
    await bootstrap.bootstrapIfNeeded();
    const world = worldWith({ [OWN]: BINDS('own-key') }, { values: OWN_FORM });
    try {
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(world.count((c) => c.url === `${OWN}/api/health`), 0);
    } finally {
        world.restore();
    }
});

const OWN_FORM_WITH_WEB = [...OWN_FORM, { configkey: 'web_app_url', configvalue: 'https://app.bee-flow.example' }];

for (const [what, values, mode, chosen, key, noted] of [
    ['Bee Flow Cloud', CLOUD_FORM, 'self-hosted', OWN, 'own-key', CLOUD],
    ['an own server', OWN_FORM_WITH_WEB, 'cloud', CLOUD, 'cloud-key', OWN],
]) {
    test(`the form holds ${what}, another server is chosen on the setup page: after a restart the form value is still not a choice`, async () => {
        assert.equal(start().source, 'none');
        const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, { values });
        try {
            await poll(); // noted
            assert.deepEqual(fs.readdirSync(storage), [], 'noting writes no file while no server is chosen');
            await chooseOnSetupPage(mode, chosen);
            assert.equal(config.tenantKey, key);
            for (let i = 0; i < 2; i++) await poll();

            for (let round = 0; round < 2; round++) {
                assert.equal(restart().source, 'binding');
                await bootstrap.bootstrapIfNeeded();
                for (let i = 0; i < 3; i++) await poll();
            }

            assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(noted)), [], 'nothing went to the server the form names');
            assert.equal(world.count((c) => c.url.endsWith('/auth/connector/bootstrap')), 1, 'one bootstrap: the choice on the setup page');
            assert.equal(adminReads(world), 1, 'the administrators were read for that one bootstrap');
            assert.equal(config.apiBaseUrl, chosen);
            assert.equal(config.tenantKey, key);
            assert.equal(setupConfig.get()?.apiBaseUrl, chosen);
            assert.equal(setupConfig.get()?.embedBaseUrl, undefined);
        } finally {
            world.restore();
        }
    });
}

test('a noted own server that is then chosen on the setup page: the form\'s web app address stays without effect, also after a restart', async () => {
    start();
    const world = worldWith({ [OWN]: BINDS('own-key') }, { values: OWN_FORM_WITH_WEB });
    try {
        await poll();
        await chooseOnSetupPage('self-hosted', OWN);
        await poll();
        restart();
        await bootstrap.bootstrapIfNeeded();
        for (let i = 0; i < 3; i++) await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(setupConfig.get()?.embedBaseUrl, undefined, 'the shell host is the one chosen on the setup page');
        assert.equal(world.count((c) => c.url === `${OWN}/auth/connector/bootstrap`), 1);
    } finally {
        world.restore();
    }
});

test('after a restart the form is followed again once it names another server', async () => {
    start();
    const form = { values: OWN_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll(); // notes the own server
        await chooseOnSetupPage('cloud', CLOUD);
        restart();
        await bootstrap.bootstrapIfNeeded();
        await poll();
        assert.equal(config.apiBaseUrl, CLOUD);

        form.values = KEEP_FORM; // the administrator opens the form and sets "No change"
        await poll();
        assert.equal(config.apiBaseUrl, CLOUD);
        form.values = OWN_FORM; // and later picks the own server
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');

        // That choice holds across the next start.
        assert.equal(restart().url, OWN);
        await bootstrap.bootstrapIfNeeded();
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(world.count((c) => c.url === `${OWN}/auth/connector/bootstrap`), 1);
    } finally {
        world.restore();
    }
});

test('an address typed next to a noted "Bee Flow Cloud" does not make Cloud the choice', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll(); // noted
        // The address field is saved first; the radio still holds the noted value.
        form.values = [...CLOUD_FORM, { configkey: 'api_base_url', configvalue: OWN }];
        for (let i = 0; i < 3; i++) await poll();
        assert.deepEqual(outsideNextcloud(world), [], 'nothing is asked or sent');
        assert.equal(config.apiBaseUrl, null);
        assert.deepEqual(fs.readdirSync(storage), []);

        form.values = OWN_FORM; // then the radio
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(CLOUD)), []);
    } finally {
        world.restore();
    }
});

test('the same edit on an install connected through the setup page leaves it where it is', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        await chooseOnSetupPage('self-hosted', OWN);
        form.values = [...CLOUD_FORM, { configkey: 'api_base_url', configvalue: 'https://other.example' }];
        for (let i = 0; i < 3; i++) await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world).filter((c) => !c.includes(OWN)), []);
    } finally {
        world.restore();
    }
});

test('the first read of the form at a start follows the bootstrap of that start: a switch that does not bind leaves the key in use', async () => {
    assert.equal(start({
        'tenant-key.json': { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN },
    }).source, 'binding');
    const world = worldWith({
        [OWN]: BINDS('own-key-2'),
        [CLOUD]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => new Response('{"error":"no"}', { status: 400 }) },
    }, { values: CLOUD_FORM });
    try {
        // The order of src/server.js.
        const boot = bootstrap.bootstrapIfNeeded();
        const firstRead = declarativeSettings.startPolling();
        await Promise.all([boot, firstRead]);
        declarativeSettings.stopPolling();

        assert.equal(world.count((c) => c.url === `${CLOUD}/auth/connector/bootstrap`), 1, 'the switch was tried');
        assert.equal(world.count((c) => c.url === `${OWN}/auth/connector/bootstrap`), 0, 'no new bootstrap at the bound server');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8')).tenantKey, 'own-key');
    } finally {
        declarativeSettings.stopPolling();
        world.restore();
    }
});

// The same server, written another way: not a change. The connection is left
// alone at the poll and after every restart.
for (const [what, typed] of [
    ['with a trailing slash', `${OWN}/`],
    ['with several trailing slashes', `${OWN}//`],
    ['with the host in capitals', OWN.replace('bee-flow.example', 'Bee-Flow.EXAMPLE')],
    ['with the default port written out', `${OWN}:443/`],
]) {
    test(`the form names the server in use ${what}: no new bootstrap, the key and its file stay, also after a restart`, async () => {
        const binding = { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN, provisionedAt: '2026-01-01T00:00:00.000Z' };
        assert.equal(start({ 'tenant-key.json': binding }).source, 'binding');
        await bootstrap.bootstrapIfNeeded();
        const form = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: typed }];
        const world = worldWith({ [OWN]: BINDS('another-key') }, { values: form });
        try {
            for (let round = 0; round < 2; round++) {
                await poll();
                await poll();
                assert.deepEqual(outsideNextcloud(world), [], 'nothing is asked of the Bee Flow server');
                assert.equal(config.apiBaseUrl, OWN);
                assert.equal(config.tenantKey, 'own-key');
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8')), binding, 'the binding file is not rewritten');
                // The same volume, a new process.
                assert.equal(restart().source, 'binding');
                await bootstrap.bootstrapIfNeeded();
            }
        } finally {
            world.restore();
        }
    });
}

test('a first choice typed with a trailing slash is kept without it, and the next polls ask for nothing', async () => {
    start();
    const form = { values: [] };
    const world = worldWith({ [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        form.values = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: `${OWN}/` }];
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(setupConfig.get()?.apiBaseUrl, OWN);
        const binds = () => world.count((c) => c.url === `${OWN}/auth/connector/bootstrap`);
        assert.equal(binds(), 1);
        await poll();
        await poll();
        assert.equal(binds(), 1);
    } finally {
        world.restore();
    }
});

test('a refused switch the form no longer asks for is no longer reported', async () => {
    const binding = { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN, provisionedAt: '2026-01-01T00:00:00.000Z' };
    const DOWN = 'https://nowhere.example';
    const OTHER = 'https://other-down.example';
    const down = () => { throw new TypeError('fetch failed'); };
    const unreachable = { 'GET /api/health': down, 'POST /auth/connector/bootstrap': down };
    const DOWN_FORM = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: `${DOWN}/` }];
    for (const [what, withdrawn] of [['"No change"', KEEP_FORM], ['the server in use', OWN_FORM]]) {
        assert.equal(start({ 'tenant-key.json': binding }).source, 'binding');
        await bootstrap.bootstrapIfNeeded();
        const form = { values: DOWN_FORM };
        const world = worldWith({ [OWN]: BINDS('must-not-be-asked'), [DOWN]: unreachable, [OTHER]: unreachable }, form);
        try {
            await poll();
            assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, DOWN);
            await poll();
            assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, DOWN, 'kept while the form still names that server');

            form.values = withdrawn;
            await poll();
            assert.equal(bootstrap.getRejectedSwitch(), null, `the form is back on ${what}`);
            assert.equal(config.apiBaseUrl, OWN);
            assert.equal(config.tenantKey, 'own-key');
            assert.equal(world.count((c) => c.url.startsWith(`${OWN}/`)), 0, 'the server in use is asked for nothing');

            // A switch refused on the setup page is not the form's to withdraw.
            form.values = DOWN_FORM;
            await poll();
            await chooseOnSetupPage('self-hosted', OTHER).catch(() => {});
            assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, OTHER);
            form.values = withdrawn;
            await poll();
            assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, OTHER);
        } finally {
            world.restore();
        }
    }
});

test('the form names a server that does not answer: the switch is tried once, then the connection in use is left alone until a server answers there', async () => {
    const binding = { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN, provisionedAt: '2026-01-01T00:00:00.000Z' };
    assert.equal(start({ 'tenant-key.json': binding }).source, 'binding');
    await bootstrap.bootstrapIfNeeded();
    const DOWN = 'https://nowhere.example';
    let up = false;
    const down = () => { throw new TypeError('fetch failed'); };
    const world = worldWith({
        [OWN]: BINDS('must-not-be-asked'),
        [DOWN]: {
            'GET /api/health': () => (up ? { status: 'ok' } : down()),
            'POST /auth/connector/bootstrap': () => (up ? { tenantKey: 'new-key', organizationId: 'org-new' } : down()),
        },
    }, { values: [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: DOWN }] });
    const keyFile = () => fs.readFileSync(path.join(storage, 'tenant-key.json'), 'utf8');
    const attempts = () => world.count((c) => c.url === `${DOWN}/auth/connector/bootstrap`);
    try {
        await poll();
        assert.equal(attempts(), 1, 'the switch was tried');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, DOWN);
        assert.equal(bootstrap.getLastErrorState(), null, 'no failure on record for the server in use');
        const kept = keyFile();
        const keptAt = fs.statSync(path.join(storage, 'tenant-key.json')).mtimeMs;

        for (let i = 0; i < 4; i++) await poll();
        assert.equal(attempts(), 1, 'not tried again while no server answers there');
        assert.equal(world.count((c) => c.url === `${DOWN}/api/health`), 4, 'each poll only asks whether a server is there');
        assert.equal(world.count((c) => c.url.startsWith(`${OWN}/`)), 0, 'the server in use is asked for nothing');
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(keyFile(), kept);
        assert.equal(fs.statSync(path.join(storage, 'tenant-key.json')).mtimeMs, keptAt, 'the binding file is not rewritten');

        // The server comes up: the form still names it, the switch happens.
        up = true;
        await poll();
        assert.equal(config.apiBaseUrl, DOWN);
        assert.equal(config.tenantKey, 'new-key');
        assert.equal(attempts(), 2);
        await poll();
        assert.equal(attempts(), 2);
    } finally {
        world.restore();
    }
});

test('the note about the form is written about the moment it is written: after a choice it does not say no server is chosen', async () => {
    start();
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let failing = true;
    const world = installFakeWorld({
        servers: { [OWN]: BINDS('own-key') },
        nc: (_method, url) => {
            if (!url.includes('/ex-app/config/get-values')) return undefined;
            return failing ? new Response('', { status: 401 }) : ocs([]);
        },
    });
    try {
        await poll(); // the read at the start fails
        await chooseOnSetupPage('self-hosted', OWN);
        failing = false;
        await poll();
        const notes = lines.filter((l) => l.startsWith('[Settings]'));
        assert.equal(notes.length, 1);
        assert.doesNotMatch(notes[0], /no Bee Flow server is chosen/);
        assert.match(notes[0], /count as a choice once they are changed/);
        assert.equal(config.apiBaseUrl, OWN, 'and the noted values change nothing');
    } finally {
        console.log = realLog;
        world.restore();
    }
});
