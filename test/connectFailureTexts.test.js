// What a failed connect leaves behind for the administrator: the answer of the
// action, the record on the volume (bootstrap-last-error.json) and the log.
//
//   - The record and the answer name the server this install is on, like the
//     heartbeat and the diagnostics do, whatever text the server sent along.
//   - A failure of the connector's own read of Nextcloud is not reported as
//     "the Bee Flow server cannot reach this Nextcloud", and its cause is named.
//   - A switch that is rolled back leaves the record of the server that stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installWithStorage, NO_SERVER } = require('./support/installValues');

const CLOUD = 'https://server.beeflow.nl';
const OWN = 'http://bee-flow.own.test:3001';
const OTHER = 'https://other.bee-flow.test';
const storage = installWithStorage('bf-connector-failure-texts-', NO_SERVER);

const { installFakeWorld, json } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');

// The answer of a Bee Flow server that cannot call this Nextcloud back, with
// the text such a server sends along.
const CANNOT_CALL_BACK = () => json({
    error: 'Could not verify NC instance ownership: NC capabilities unreachable: fetch failed',
    code: 'nc_capabilities_unreachable',
    remediation: 'Bee Flow Cloud could not reach your Nextcloud at http://nc.test. Your Nextcloud must be publicly reachable.',
}, 403);
const tlsFailure = () => new TypeError('fetch failed', {
    cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
});
const errorFile = () => {
    try { return JSON.parse(fs.readFileSync(path.join(storage, 'bootstrap-last-error.json'), 'utf8')); } catch { return null; }
};

let warned = [];
const realWarn = console.warn;
test.beforeEach(() => { warned = []; console.warn = (...a) => warned.push(a.join(' ')); });
test.afterEach(() => { console.warn = realWarn; });
test.after(() => {
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

/** The install right after installing: empty storage, no server. */
async function freshInstall() {
    setupConfig.init(storage);
    setupConfig.clear();
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    serverChoice.applyAtBoot(config, setupConfig.get());
    config.organizationId = null;
    config.ncInstanceId = null;
    config.pairingCode = null;
    // Drops the failure of an earlier test from memory as well.
    if (bootstrap.getLastErrorState()) {
        config.apiBaseUrl = OWN;
        const world = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'k', organizationId: 'o' }) } } });
        try { await bootstrap.bootstrapIfNeeded(); } finally { world.restore(); }
        for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
        config.apiBaseUrl = null;
        config.tenantKey = null;
        config.ncInstanceId = null;
    }
    assert.equal(bootstrap.getLastErrorState(), null);
}

test('the text for a Nextcloud the server cannot call back follows the server: Cloud, or your own', () => {
    const saved = config.apiBaseUrl;
    try {
        config.apiBaseUrl = CLOUD;
        const cloud = bootstrap.remediationFor('nc_not_publicly_reachable');
        assert.match(cloud, /^Bee Flow Cloud cannot reach this Nextcloud/);
        assert.match(cloud, /reachable from the internet/);
        assert.match(cloud, /setup page/);
        assert.doesNotMatch(cloud, /NEXTCLOUD_ALLOW_PRIVATE_HOSTS|self-hosted/);

        config.apiBaseUrl = OWN;
        const own = bootstrap.remediationFor('nc_not_publicly_reachable');
        assert.ok(own.startsWith(`Your Bee Flow server (${OWN}) cannot reach this Nextcloud`));
        assert.match(own, /http:\/\/nc\.test/, 'the address the connector reports is named');
        assert.match(own, /set NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 in the environment of the Bee Flow server/);
        assert.match(own, /setup page/);
        assert.doesNotMatch(own, /Bee Flow Cloud|needs a self-hosted/);
    } finally {
        config.apiBaseUrl = saved;
    }
});

test('your own server refuses: the answer, the record on the volume and the log name that server, not Bee Flow Cloud', async () => {
    await freshInstall();
    const world = installFakeWorld({ servers: { [OWN]: { 'POST /auth/connector/bootstrap': CANNOT_CALL_BACK } } });
    try {
        const first = await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch((e) => e);
        assert.ok(first instanceof Error);
        assert.equal(config.apiBaseUrl, OWN, 'a first choice stays');
        const expected = bootstrap.remediationFor('nc_not_publicly_reachable');
        assert.ok(expected.startsWith(`Your Bee Flow server (${OWN})`));

        assert.equal(first.remediation, expected);
        assert.doesNotMatch(first.message, /SaaS/);
        assert.ok(first.message.startsWith(`Your Bee Flow server (${OWN}) refused the connection (HTTP 403)`), first.message);

        const record = errorFile();
        assert.equal(record.category, 'nc_not_publicly_reachable');
        assert.equal(record.remediation, expected);
        assert.doesNotMatch(JSON.stringify(record), /Bee Flow Cloud|SaaS/);

        // The same failure through a pairing code on the chosen server.
        const paired = await bootstrap.invalidateAndRebootstrap({ pairingCode: 'ZZZZ-9999' }).catch((e) => e);
        assert.equal(paired.remediation, expected);
        assert.equal(errorFile().remediation, expected);
        // No key before, none now: the log does not speak of a previous key.
        const rollback = warned.find((line) => line.includes('re-bootstrap failed'));
        assert.ok(rollback, 'the failed attempt is logged');
        assert.doesNotMatch(rollback, /rolling back to previous tenant key/);
        assert.match(rollback, new RegExp(`staying on ${OWN.replace(/[.]/g, '\\.')}, there was no tenant key before`));
    } finally {
        world.restore();
    }
});

test('a text the server sends for a failure of its own is kept as it is', async () => {
    await freshInstall();
    const world = installFakeWorld({
        servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => json({
            error: 'Too many pending bindings', code: 'too_many_pending_bindings', remediation: 'Wait for the existing verification codes to expire.',
        }, 429) } },
    });
    try {
        const err = await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch((e) => e);
        assert.equal(err.remediation, 'Wait for the existing verification codes to expire.');
        assert.equal(errorFile().remediation, 'Wait for the existing verification codes to expire.');
        // Diagnostics and the heartbeat show that same text.
        assert.equal(bootstrap.remediationShown(bootstrap.getLastErrorState()), 'Wait for the existing verification codes to expire.');
    } finally {
        world.restore();
    }
});

test('a pairing code the server does not accept: one category, one text everywhere, naming the server and the setup page', async () => {
    await freshInstall();
    const world = installFakeWorld({
        servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => json({
            error: 'Pairing code is invalid, expired, or already used',
            code: 'pairing_code_invalid',
            remediation: 'Set it as the BEEFLOW_PAIRING_CODE env var on this connector and reinstall.',
        }, 401) } },
    });
    try {
        const err = await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN, pairingCode: 'ZZZZ-9999' }).catch((e) => e);
        const record = bootstrap.getLastErrorState();
        assert.equal(record.category, 'pairing_code_invalid', 'not "the connector\'s credentials were rejected"');
        const text = bootstrap.remediationFor('pairing_code_invalid');
        assert.ok(text.startsWith(`Your Bee Flow server (${OWN}) does not accept this pairing code`), text);
        assert.match(text, /setup page/);
        assert.doesNotMatch(text, /BEEFLOW_PAIRING_CODE|reinstall|redeploy/);
        // The answer to the administrator, the file on the volume, and what
        // diagnostics and the heartbeat show.
        assert.equal(err.remediation, text);
        assert.equal(errorFile().remediation, text);
        assert.equal(bootstrap.remediationShown(record), text);
        // The setup page has a name for it.
        const { CATEGORY_TO_CONNECT_ERROR, CONNECT_ERRORS } = require('../src/setupTexts');
        assert.equal(CATEGORY_TO_CONNECT_ERROR[record.category], 'pairing_code_invalid');
        assert.match(CONNECT_ERRORS.pairing_code_invalid, /does not accept this pairing code/);
        // Asking again would not change the answer: no retry is scheduled.
        assert.equal(record.nextRetryAt === null || bootstrap._bootstrapRetryArmedForTests() === false, true);
    } finally {
        world.restore();
    }
});

test('the text for a server that wants a pairing code names that server', () => {
    const saved = config.apiBaseUrl;
    try {
        config.apiBaseUrl = OWN;
        assert.ok(bootstrap.remediationFor('pairing_required').startsWith(`Your Bee Flow server (${OWN}) does not create an organisation by itself`));
        config.apiBaseUrl = CLOUD;
        assert.ok(bootstrap.remediationFor('pairing_required').startsWith('Bee Flow Cloud does not create an organisation by itself'));
        config.apiBaseUrl = null;
        assert.ok(bootstrap.remediationFor('pairing_required').startsWith('The Bee Flow server does not create an organisation by itself'));
    } finally {
        config.apiBaseUrl = saved;
    }
});

test('the connector cannot read Nextcloud: its own category, the cause named, nothing sent to the server', async () => {
    for (const [failure, category, cause, hint] of [
        [tlsFailure, 'nc_cert_untrusted', /DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate/, /BEEFLOW_NC_CA_CERT/],
        [() => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
            'nc_unreachable', /ECONNREFUSED/, /http:\/\/nc\.test/],
    ]) {
        await freshInstall();
        const world = installFakeWorld({
            servers: { [OWN]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'never', organizationId: 'never' }) } },
            nc: (_method, url) => { if (url.includes('/cloud/capabilities')) throw failure(); return undefined; },
        });
        try {
            await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch((e) => e);
            const state = bootstrap.getLastErrorState();
            assert.equal(state.category, category);
            assert.equal(state.phase, 'capabilities');
            assert.match(state.error, cause);
            assert.ok(warned.some((line) => cause.test(line)), 'the log names the cause');
            const text = bootstrap.remediationFor(category);
            assert.match(text, hint);
            assert.match(text, /Nothing was sent to the Bee Flow server/);
            assert.doesNotMatch(text, /cannot reach this Nextcloud at the address the connector reports/);
            assert.equal(errorFile().remediation, text);
            assert.equal(world.count((c) => c.url.startsWith(OWN)), 0, 'no request to the Bee Flow server');
        } finally {
            world.restore();
        }
    }
});

test('a switch that is rolled back leaves the failure record of the server that stays', async () => {
    await freshInstall();
    const world = installFakeWorld({
        servers: {
            [OWN]: { 'POST /auth/connector/bootstrap': CANNOT_CALL_BACK },
            [OTHER]: { 'POST /auth/connector/bootstrap': () => { throw tlsFailure(); } },
        },
    });
    try {
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }).catch(() => {});
        const before = bootstrap.getLastErrorState();
        assert.equal(before.category, 'nc_not_publicly_reachable');

        const err = await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OTHER }).catch((e) => e);
        assert.ok(err instanceof Error, 'the switch failed');
        assert.equal(config.apiBaseUrl, OWN);
        const after = bootstrap.getLastErrorState();
        assert.equal(after.category, 'nc_not_publicly_reachable', 'not the certificate failure of the server that was not taken');
        assert.equal(after.error, before.error);
        assert.equal(errorFile().category, 'nc_not_publicly_reachable');
        // The failure of the switch is kept apart, with the server it is about.
        const rejected = bootstrap.getRejectedSwitch();
        assert.equal(rejected.apiBaseUrl, OTHER);
        assert.equal(rejected.category, 'saas_cert_untrusted');
        assert.match(rejected.error, /DEPTH_ZERO_SELF_SIGNED_CERT/);
        assert.match(rejected.remediation, /BEEFLOW_SERVER_CA_CERT/);
        assert.ok(Date.parse(rejected.at) >= Date.parse(before.lastAttemptAt));
    } finally {
        world.restore();
    }
});

test('a rolled-back switch away from a connected server leaves no failure on record', async () => {
    await freshInstall();
    const world = installFakeWorld({
        servers: {
            [OWN]: { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'own-key', organizationId: 'org-own' }) },
            [OTHER]: { 'POST /auth/connector/bootstrap': () => { throw tlsFailure(); } },
        },
    });
    try {
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN });
        assert.equal(config.tenantKey, 'own-key');
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OTHER }).catch(() => {});
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(bootstrap.getLastErrorState(), null);
        assert.equal(errorFile(), null);
        assert.equal(bootstrap.getRejectedSwitch()?.apiBaseUrl, OTHER);
        // The next change of server starts without it.
        await bootstrap.invalidateAndRebootstrap();
        assert.equal(bootstrap.getRejectedSwitch(), null);
        const rollback = warned.find((line) => line.includes('re-bootstrap failed'));
        assert.match(rollback, /keeping the previous tenant key/);
    } finally {
        world.restore();
    }
});
