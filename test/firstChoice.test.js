// The first choice of a Bee Flow server, on the setup page (POST /setup).
//
// The connector has no server until an administrator chooses one. The choice
// itself: the address is asked for /api/health first, and nothing is saved or
// sent when no Bee Flow server answers there. Once it does, the choice is saved
// and stays chosen, also when connecting then needs something more (a pairing
// code). A server fixed at install time is not changed from here, and an
// install-time tenant key is taken into use without a bootstrap request.
//
// The routes run for real (express, setup router, bootstrap, settings poll);
// only the network is replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installWithStorage, NO_SERVER } = require('./support/installValues');

const CLOUD = 'https://server.beeflow.nl';
const OWN = 'https://bee-flow.example';
const OTHER = 'https://other.bee-flow.example';
// nothing chosen at install time
const storage = installWithStorage('bf-connector-first-choice-', NO_SERVER);

const express = require('express');
const { installFakeWorld, json, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');
const setupRouter = require('../src/setup');
const declarativeSettings = require('../src/declarativeSettings');
const { SETUP_TEXTS, CONNECT_ERRORS } = require('../src/setupTexts');

const nl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'nl.json'), 'utf8')).translations;
const realFetch = globalThis.fetch;
const HEALTHY = { 'GET /api/health': () => ({ status: 'ok' }) };
const PAIRING_REQUIRED = () => json({ error: 'This Bee Flow server does not auto-create organisations.', code: 'pairing_required' }, 403);

/** The install as it is right after installing: empty storage, no server. */
function freshInstall() {
    setupConfig.init(storage);
    setupConfig.clear(); // also what an earlier test left in memory
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    const choice = serverChoice.applyAtBoot(config, setupConfig.get());
    assert.equal(choice.source, 'none');
    config.organizationId = null;
    config.organizationName = null;
    config.ncInstanceId = null;
    config.pairingCode = null;
    declarativeSettings._resetForTests();
}

let caller = 0;
/**
 * One request to the setup router. Every call of `as()` is another Nextcloud
 * account, so no test spends the request budget of another.
 * @param {{ isNcAdmin?: boolean, language?: string | null }} [who]
 */
function as({ isNcAdmin = true, language = null } = {}) {
    const uid = `admin-${++caller}`;
    return async (method, pathname, body) => {
        const app = express();
        app.use((req, _res, next) => { req.beeflow = { user: { uid, isNcAdmin, language } }; next(); });
        app.use('/setup', setupRouter);
        const server = app.listen(0);
        try {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            const res = await realFetch(`http://127.0.0.1:${port}${pathname}`, {
                method,
                ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            });
            const text = await res.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* a page */ }
            return { status: res.status, body: parsed, text };
        } finally {
            server.close();
        }
    };
}

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, what, ms = 3000) {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error(`not reached in time: ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8')); } catch { return null; }
};
// A choice is marked as made on the setup page once connecting to it is over
// (bound, waiting for a code, or failed and kept).
const choiceSettled = () => config.serverSource === 'picker';
const bootstrapsAt = (world, base) => world.count((c) => c.url === `${base}/auth/connector/bootstrap`);
const adminReads = (world) => world.count((c) => c.url.includes('/cloud/groups/admin/users'));

test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

test('an address where no Bee Flow server answers is not saved, and nothing is sent', async () => {
    freshInstall();
    const world = installFakeWorld({
        servers: { [OWN]: { 'GET /api/health': () => { throw new TypeError('fetch failed'); } } },
    });
    try {
        const res = await as()('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(res.status, 502);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.code, 'server_unreachable');
        assert.equal(res.body.error, CONNECT_ERRORS.server_unreachable);

        assert.equal(config.apiBaseUrl, null, 'no server');
        assert.equal(config.tenantKey, null);
        assert.equal(setupConfig.get(), null, 'no saved choice');
        assert.deepEqual(fs.readdirSync(storage), [], 'no file written');

        // The one request made: a bare GET of /api/health.
        assert.deepEqual(world.calls.map((c) => `${c.method} ${c.url}`), [`GET ${OWN}/api/health`]);
        assert.equal(world.calls[0].body, null);
        assert.deepEqual(world.calls[0].headers, {});

        const diagnostics = (await as()('GET', '/setup/diagnostics')).body;
        assert.equal(diagnostics.state, 'server_not_chosen');
    } finally {
        world.restore();
    }
});

test('a server that answers /api/health with an error is not saved either', async () => {
    freshInstall();
    const world = installFakeWorld({ servers: { [OWN]: { 'GET /api/health': () => json({ error: 'starting' }, 503) } } });
    try {
        const res = await as()('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(res.status, 502);
        assert.equal(res.body.code, 'server_unreachable');
        assert.equal(res.body.detail, 'HTTP 503');
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
        assert.equal(world.calls.length, 1);
    } finally {
        world.restore();
    }
});

test('a certificate that is not trusted is named, in the administrator\'s language', async () => {
    freshInstall();
    const world = installFakeWorld({
        servers: {
            [OWN]: {
                'GET /api/health': () => {
                    throw Object.assign(new TypeError('fetch failed'), {
                        cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
                    });
                },
            },
        },
    });
    try {
        const res = await as({ language: 'nl' })('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(res.status, 502);
        assert.equal(res.body.code, 'certificate_not_trusted');
        assert.equal(res.body.error, nl[CONNECT_ERRORS.certificate_not_trusted]);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
    } finally {
        world.restore();
    }
});

test('Bee Flow Cloud as the first choice: probed first, then bound and pinned', async () => {
    freshInstall();
    const world = installFakeWorld({
        servers: {
            [CLOUD]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'cloud-key', organizationId: 'org-cloud', organizationName: 'Cloud Org' }) },
        },
    });
    try {
        const admin = as();
        const res = await admin('POST', '/setup', { mode: 'cloud' });
        assert.equal(res.status, 200);
        assert.equal(res.body.firstChoice, true);
        assert.equal(res.body.saved.apiBaseUrl, CLOUD);
        assert.ok(Date.parse(res.body.startedAt) > 0);
        await until(() => choiceSettled() && readJson('tenant-key.json')?.boundApiBaseUrl === CLOUD, 'bound to Cloud');
        assert.equal(config.tenantKey, 'cloud-key');

        assert.equal(config.apiBaseUrl, CLOUD);
        assert.equal(setupConfig.get()?.mode, 'cloud');
        assert.equal(readJson('setup-config.json')?.apiBaseUrl, CLOUD);

        // The probe comes before anything is read from Nextcloud or sent.
        const order = world.calls.map((c) => c.url);
        const probeAt = order.indexOf(`${CLOUD}/api/health`);
        assert.equal(probeAt, 0);
        assert.ok(order.findIndex((u) => u.includes('/cloud/groups/admin/users')) > probeAt);
        assert.equal(bootstrapsAt(world, CLOUD), 1);

        const status = (await admin('GET', '/setup/status')).body;
        assert.equal(status.configured, true);
        assert.equal(status.active, CLOUD);
        assert.equal(status.source, 'picker');
        assert.equal(status.legacyCloudEnv, false);

        const diagnostics = (await admin('GET', '/setup/diagnostics')).body;
        assert.equal(diagnostics.state, 'ok');
        assert.equal(diagnostics.organizationName, 'Cloud Org');
        assert.equal(diagnostics.connectError, null);
    } finally {
        world.restore();
    }
});

test('a server that asks for a pairing code stays chosen; the code in the next save binds', async () => {
    freshInstall();
    let seenCode = null;
    const world = installFakeWorld({
        servers: {
            [OWN]: {
                ...HEALTHY,
                'POST /auth/connector/bootstrap': (init) => {
                    seenCode = init.headers['X-Beeflow-Pairing-Code'] || null;
                    return seenCode === 'ABCD-1234' ? { tenantKey: 'paired-key', organizationId: 'org-own' } : PAIRING_REQUIRED();
                },
            },
        },
    });
    try {
        const admin = as({ language: 'nl' });
        const first = await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(first.status, 200);
        assert.equal(first.body.firstChoice, true);
        await until(async () => choiceSettled() && (await admin('GET', '/setup/diagnostics')).body.state === 'failed', 'the failure is recorded');

        // Chosen, not bound.
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, null);
        assert.equal(setupConfig.get()?.apiBaseUrl, OWN, 'the choice survives a restart');
        assert.equal(bootstrap._bootstrapRetryArmedForTests(), false, 'asking again without a code changes nothing');

        const diagnostics = (await admin('GET', '/setup/diagnostics')).body;
        assert.equal(diagnostics.apiBaseUrl, OWN);
        assert.equal(diagnostics.lastError.category, 'pairing_required');
        assert.ok(Date.parse(diagnostics.lastError.lastAttemptAt) >= Date.parse(first.body.startedAt));
        assert.deepEqual(diagnostics.connectError, { code: 'pairing_code_required', error: nl[CONNECT_ERRORS.pairing_code_required] });

        const status = (await admin('GET', '/setup/status')).body;
        assert.equal(status.configured, true);
        assert.equal(status.source, 'picker');

        // The same save again, now with the code (typed in lower case).
        const second = await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN, pairingCode: 'abcd-1234' });
        assert.equal(second.status, 200);
        assert.equal(second.body.firstChoice, false);
        // The key is in memory before its cache file and the rest of the bind land.
        await until(() => readJson('tenant-key.json')?.boundApiBaseUrl === OWN && config.pairingCode === null, 'bound with the pairing code');
        assert.equal(seenCode, 'ABCD-1234');
        assert.equal(config.tenantKey, 'paired-key');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal((await admin('GET', '/setup/diagnostics')).body.state, 'ok');
    } finally {
        world.restore();
    }
});

test('a pairing code given with the first choice binds in that one save', async () => {
    freshInstall();
    const codes = [];
    const world = installFakeWorld({
        servers: {
            [OWN]: {
                ...HEALTHY,
                'POST /auth/connector/bootstrap': (init) => {
                    codes.push(init.headers['X-Beeflow-Pairing-Code'] || null);
                    return { tenantKey: 'paired-key', organizationId: 'org-own' };
                },
            },
        },
    });
    try {
        const res = await as()('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN, pairingCode: 'WXYZ-9876' });
        assert.equal(res.status, 200);
        await until(() => choiceSettled() && config.tenantKey === 'paired-key', 'bound');
        assert.deepEqual(codes, ['WXYZ-9876']);
    } finally {
        world.restore();
    }
});

test('a pairing code in the wrong shape is refused before anything is asked or saved', async () => {
    freshInstall();
    const world = installFakeWorld({ servers: { [OWN]: HEALTHY } });
    try {
        const res = await as()('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN, pairingCode: 'not a code' });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'invalid_pairing_code');
        assert.equal(world.calls.length, 0);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
    } finally {
        world.restore();
    }
});

test('a failed switch away from a working server still goes back to it, saved choice included', async () => {
    freshInstall();
    let attempted = false;
    const world = installFakeWorld({
        servers: {
            [OWN]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'own-key', organizationId: 'org-own' }) },
            [OTHER]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => { attempted = true; return json({ error: 'down' }, 503); } },
        },
    });
    try {
        const admin = as();
        await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        await until(() => choiceSettled() && readJson('tenant-key.json')?.boundApiBaseUrl === OWN, 'bound to the first server');
        assert.equal(config.tenantKey, 'own-key');

        const res = await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OTHER });
        assert.equal(res.status, 200);
        assert.equal(res.body.firstChoice, false);
        await until(() => attempted && config.tenantKey === 'own-key' && setupConfig.get()?.apiBaseUrl === OWN, 'rolled back');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(readJson('setup-config.json')?.apiBaseUrl, OWN, 'a restart does not move to the server that refused');
        assert.equal(readJson('tenant-key.json')?.tenantKey, 'own-key');
    } finally {
        world.restore();
    }
});

test('a server fixed at install time is not changed from the setup page: 409', async () => {
    freshInstall();
    config.apiBaseUrl = OWN;
    config.apiBaseUrlLocked = true;
    const world = installFakeWorld({ servers: { [OTHER]: HEALTHY } });
    try {
        const res = await as()('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OTHER });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'env_locked');
        assert.equal(world.calls.length, 0);
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(setupConfig.get(), null);
    } finally {
        config.apiBaseUrlLocked = false;
        world.restore();
    }
});

test('somebody who is not a Nextcloud administrator cannot choose: 403', async () => {
    freshInstall();
    const world = installFakeWorld({ servers: { [CLOUD]: HEALTHY } });
    try {
        const res = await as({ isNcAdmin: false })('POST', '/setup', { mode: 'cloud' });
        assert.equal(res.status, 403);
        assert.equal(res.body.code, 'not_admin');
        assert.equal(world.calls.length, 0);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
    } finally {
        world.restore();
    }
});

test('an install-time tenant key is taken into use by the choice, without a bootstrap request', async () => {
    freshInstall();
    config.isAutoTenantKey = false;
    config.envTenantKey = 'pasted-tenant-key';
    const world = installFakeWorld({
        servers: { [OWN]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'never-used' }) } },
    });
    try {
        assert.equal(config.tenantKey, null, 'no server, so the key is not in memory yet');
        const admin = as();
        const res = await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        assert.equal(res.status, 200);
        await until(() => choiceSettled() && config.tenantKey === 'pasted-tenant-key', 'the key is in use');

        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(setupConfig.get()?.apiBaseUrl, OWN);
        assert.equal(bootstrapsAt(world, OWN), 0, 'no bootstrap request');
        assert.equal(adminReads(world), 0, 'the administrators are not read');
        assert.equal(readJson('tenant-key.json'), null, 'an install-time key is not cached');
        assert.equal((await admin('GET', '/setup/diagnostics')).body.state, 'ok');
    } finally {
        config.isAutoTenantKey = true;
        config.envTenantKey = null;
        world.restore();
    }
});

test('the settings form does not repeat a first choice that stayed chosen', async () => {
    freshInstall();
    let bootstraps = 0;
    let form = []; // nothing filled in yet
    const world = installFakeWorld({
        servers: { [OWN]: { ...HEALTHY, 'POST /auth/connector/bootstrap': () => { bootstraps += 1; return PAIRING_REQUIRED(); } } },
        nc: (method, url) => (url.includes('/ex-app/config/get-values') ? ocs(form) : undefined),
    });
    try {
        await declarativeSettings.applyStoredValuesIfChanged(); // the poll at the start
        // The administrator chooses in the form.
        form = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: OWN }];
        for (let i = 0; i < 3; i++) await declarativeSettings.applyStoredValuesIfChanged();
        assert.equal(bootstraps, 1, 'one attempt, not one per poll');
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, null);
        assert.equal(setupConfig.get()?.apiBaseUrl, OWN, 'the choice is saved');
    } finally {
        world.restore();
    }
});

test('the status names what the page needs for the choice, in the administrator\'s language', async () => {
    freshInstall();
    process.env.BEEFLOW_API_BASE_URL = CLOUD; // the literal address: not a choice
    try {
        const status = (await as({ language: 'nl_NL' })('GET', '/setup/status')).body;
        assert.equal(status.canConfigure, true);
        assert.equal(status.configured, false);
        assert.equal(status.active, null);
        assert.equal(status.source, 'none');
        assert.equal(status.legacyCloudEnv, true);
        assert.equal(status.envOverridden, false);
        assert.equal(status.selfHostingDocsUrl, 'https://docs.beeflow.ai/self-hosting');
        assert.equal(status.texts.consent, nl[SETUP_TEXTS.consent]);
        assert.ok(status.texts.consent.includes('{host}'), 'the page fills in the host');
        assert.equal(status.texts.selfHostingLink, nl[SETUP_TEXTS.selfHostingLink]);
        assert.equal(status.texts.literalCloudEnv, nl[SETUP_TEXTS.literalCloudEnv]);
        assert.deepEqual(Object.keys(status.texts.errors).sort(),
            ['certificate_not_trusted', 'pairing_code_invalid', 'pairing_code_required', 'server_unreachable', 'version_mismatch']);
        for (const [code, text] of Object.entries(CONNECT_ERRORS)) assert.equal(status.texts.errors[code], nl[text]);

        const english = (await as()('GET', '/setup/status')).body;
        assert.equal(english.texts.consent, SETUP_TEXTS.consent);
        assert.deepEqual(english.texts.errors, CONNECT_ERRORS);
    } finally {
        delete process.env.BEEFLOW_API_BASE_URL;
    }
});

test('every text of the choice has a Dutch translation, and none carries a command', () => {
    for (const text of [...Object.values(SETUP_TEXTS), ...Object.values(CONNECT_ERRORS)]) {
        assert.ok(nl[text], `no Dutch translation for "${text}"`);
        for (const shown of [text, nl[text]]) assert.doesNotMatch(shown, /\bocc\b|setenv|docker|curl|`/);
    }
});

test('a server without a connector endpoint is named as a version mismatch', async () => {
    freshInstall();
    const world = installFakeWorld({ servers: { [OWN]: HEALTHY } }); // every other path answers 404
    try {
        const admin = as();
        await admin('POST', '/setup', { mode: 'self-hosted', apiBaseUrl: OWN });
        await until(async () => choiceSettled() && (await admin('GET', '/setup/diagnostics')).body.state === 'failed', 'the failure is recorded');
        const diagnostics = (await admin('GET', '/setup/diagnostics')).body;
        assert.equal(diagnostics.lastError.category, 'version_mismatch');
        assert.deepEqual(diagnostics.connectError, { code: 'version_mismatch', error: CONNECT_ERRORS.version_mismatch });
        assert.equal(config.apiBaseUrl, OWN, 'the choice stays');
    } finally {
        world.restore();
    }
});
