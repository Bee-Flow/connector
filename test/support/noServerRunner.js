// Forked by noServerChosen.test.js with netGuard.js preloaded: boots the real
// connector (src/server.js) with the environment the test gives it, and answers
// the parent's questions about the state inside the process.
//
// Booting already runs what a real start runs: the bootstrap, the background
// init, the first settings-form poll and the Studio menu sync. On 'facts' the
// same four run once more, awaited, so the answer is given after they finished.

require('../../src/server');

const config = require('../../src/config');
const bootstrap = require('../../src/bootstrap');
const heartbeat = require('../../src/heartbeat');
const declarativeSettings = require('../../src/declarativeSettings');
const studioAppMenus = require('../../src/studioAppMenus');
const auth = require('../../src/auth');
const { diverted } = require('./netGuard');

async function facts() {
    await bootstrap.bootstrapIfNeeded();
    await heartbeat.runInitInBackground();
    await declarativeSettings.applyStoredValuesIfChanged();
    const menuSync = await studioAppMenus.syncStudioAppMenus();

    let mintError = null;
    try {
        auth.mintSaasJwt({ uid: 'admin', email: 'admin@nc.test', displayName: 'Admin', isNcAdmin: true });
    } catch (err) {
        mintError = err.code || String(err);
    }
    return {
        apiBaseUrl: config.apiBaseUrl,
        serverSource: config.serverSource,
        tenantKey: config.tenantKey,
        envTenantKey: config.envTenantKey,
        mintError,
        retryArmed: bootstrap._bootstrapRetryArmedForTests(),
        lastError: bootstrap.getLastErrorState(),
        pending: bootstrap.getPendingState(),
        menuSync,
        diverted: [...diverted],
    };
}

process.on('message', (message) => {
    if (message !== 'facts') return;
    facts().then(
        (result) => process.send({ facts: result }),
        (err) => process.send({ error: String(err && err.stack || err) }),
    );
});
