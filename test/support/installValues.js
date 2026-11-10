// The install-time values a test file starts from. The connector's modules
// read them when they load, so a test calls this before its first require of
// anything under src/.
//
//   const storage = installWithStorage('bf-connector-switch-', NO_SERVER);
//   installValues({ ...CONNECTED, nextcloudUrl: 'http://127.0.0.1:1' });

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** An automatic tenant key, no server chosen at install time, no bootstrap retry. */
const NO_SERVER = { tenantKey: 'auto', apiBaseUrl: null, bootstrapRetryMs: '0' };
/** A server and a tenant key given at install time. */
const CONNECTED = { apiBaseUrl: 'http://beeflow.test', tenantKey: 'tenant-key' };

/** A string sets the variable, null removes it, undefined leaves it as it is. */
function setOrLeave(name, value) {
    if (value === null) delete process.env[name];
    else if (value !== undefined) process.env[name] = value;
}

/**
 * @param {{ nextcloudUrl?: string, apiBaseUrl?: string | null, tenantKey?: string | null, bootstrapRetryMs?: string | null }} [values]
 */
function installValues({ nextcloudUrl = 'http://nc.test', apiBaseUrl, tenantKey, bootstrapRetryMs } = {}) {
    process.env.APP_SECRET = 'test-secret';
    process.env.NEXTCLOUD_URL = nextcloudUrl;
    setOrLeave('BEEFLOW_API_BASE_URL', apiBaseUrl);
    setOrLeave('BEEFLOW_TENANT_KEY', tenantKey);
    setOrLeave('BEEFLOW_BOOTSTRAP_RETRY_MS', bootstrapRetryMs);
}

/**
 * The same, with a new storage directory of its own (APP_PERSISTENT_STORAGE).
 * @param {string} prefix  the name the temporary directory starts with
 * @param {Parameters<typeof installValues>[0]} [values]
 * @returns {string} the storage directory
 */
function installWithStorage(prefix, values) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    installValues(values);
    process.env.APP_PERSISTENT_STORAGE = storage;
    return storage;
}

module.exports = { installValues, installWithStorage, NO_SERVER, CONNECTED };
