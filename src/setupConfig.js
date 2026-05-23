/**
 * User-facing setup choice: which Bee Flow service does this NC point at?
 *
 * Persisted as JSON next to the tenant-key cache so it survives container
 * restarts. Read at boot to override the env-var default for `apiBaseUrl`.
 *
 * Priority for the connector's effective `apiBaseUrl`:
 *   1. Explicit BEEFLOW_API_BASE_URL env (set via `occ app_api:app:setenv`)
 *   2. setup-config.json `apiBaseUrl` written by the in-app picker
 *   3. https://server.beeflow.nl (Bee Flow Cloud)
 *
 * The env-var explicit override stays first so that an admin who locks the
 * value via AppAPI can't be silently flipped from the in-app picker.
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'setup-config.json';
const VALID_MODES = ['cloud', 'self-hosted', 'custom'];
const CLOUD_URL = 'https://server.beeflow.nl';

let cached = null;
let storageDir = null;

function _filePath() {
    if (!storageDir) throw new Error('setupConfig: storageDir not initialised');
    return path.join(storageDir, FILE_NAME);
}

function init(persistentStorage) {
    storageDir = persistentStorage;
    try {
        fs.mkdirSync(storageDir, { recursive: true });
    } catch (_) { /* dir may already exist */ }

    const file = _filePath();
    if (fs.existsSync(file)) {
        try {
            cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            console.warn(`[setupConfig] corrupted ${FILE_NAME}; ignoring (${err.message})`);
            cached = null;
        }
    }
    return cached;
}

function get() {
    return cached;
}

function save({ mode, apiBaseUrl }) {
    if (!VALID_MODES.includes(mode)) {
        throw new Error(`invalid mode "${mode}" (allowed: ${VALID_MODES.join(', ')})`);
    }
    const url = String(apiBaseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
        throw new Error('apiBaseUrl must start with http:// or https://');
    }
    const next = {
        ...(cached || {}),
        mode,
        apiBaseUrl: url,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(_filePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    cached = next;
    return cached;
}

// Persist the admin-supplied public NC URL — the one Bee Flow Cloud uses
// to call back into this Nextcloud for ownership verification + runtime
// callbacks. Lives in the same file as the apiBaseUrl picker. `null` to
// clear (fall back to NEXTCLOUD_URL).
function savePublicNcUrl(url) {
    const v = url ? String(url).trim().replace(/\/+$/, '') : null;
    if (v && !/^https?:\/\//.test(v)) {
        throw new Error('publicNcUrl must start with http:// or https://');
    }
    const next = {
        ...(cached || {}),
        publicNcUrl: v,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(_filePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    cached = next;
    return cached;
}

function chosenPublicNcUrl() {
    if (cached && cached.publicNcUrl) return cached.publicNcUrl;
    return null;
}

function clear() {
    const file = _filePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    cached = null;
}

/**
 * Return the user-chosen apiBaseUrl, or null if none has been set.
 * Caller decides how to combine with the env-var fallback.
 */
function chosenApiBaseUrl() {
    if (cached && cached.apiBaseUrl) return cached.apiBaseUrl;
    return null;
}

module.exports = { init, get, save, savePublicNcUrl, clear, chosenApiBaseUrl, chosenPublicNcUrl, CLOUD_URL, VALID_MODES };
