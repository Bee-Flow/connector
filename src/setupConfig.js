/**
 * User-facing setup choice: which Bee Flow service does this NC point at?
 *
 * Persisted as JSON next to the tenant-key cache so it survives container
 * restarts. Read at boot by serverChoice.js, which decides the connector's
 * effective `apiBaseUrl`. In short:
 *   1. BEEFLOW_API_BASE_URL fixing the server at install time (the word
 *      `cloud` or a server URL; see config.apiBaseUrlLocked)
 *   2. the server an existing binding (tenant-key.json) belongs to
 *   3. setup-config.json `apiBaseUrl`, written by the in-app picker
 *   4. no server: the connector waits for an administrator to choose
 *
 * The install-time value stays first so that an admin who fixes the server
 * there can't be silently flipped from the in-app picker.
 */

const fs = require('fs');
const path = require('path');
const { parseAllowedUrl } = require('./remoteHost');
const log = require('./log');
const { errMessage } = require('./errors');

const FILE_NAME = 'setup-config.json';
/** @type {readonly string[]} */
const VALID_MODES = ['cloud', 'self-hosted', 'custom'];
const CLOUD_URL = 'https://server.beeflow.nl';
// Bee Flow Cloud's frontend: the host of the embedded app's shell while the
// connector talks to Cloud (embedTarget.js).
const CLOUD_EMBED_URL = 'https://beeflow.nl';

/**
 * What setup-config.json holds. Every field is optional: a file written by an older version
 * carries fewer of them.
 * @typedef {object} SetupConfig
 * @property {string} [mode]
 * @property {string} [apiBaseUrl]
 * @property {string} [embedBaseUrl]  the self-hosted web app (frontend) host that goes with apiBaseUrl (#401)
 * @property {string | null} [publicNcUrl]
 * @property {string} [savedAt]
 * @property {string} [notedFormTarget]  the server the settings form named while no server was chosen
 *   (declarativeSettings.js): without effect for as long as the form names that same server
 */

/** @type {SetupConfig | null} */
let cached = null;
/** @type {string | null} */
let storageDir = null;
// A noted settings-form server that is not in the file yet: while no file
// exists nothing is written for it, and it goes along with the first write.
/** @type {string | undefined} */
let pendingNoted;

function _filePath() {
    if (!storageDir) throw new Error('setupConfig: storageDir not initialised');
    return path.join(storageDir, FILE_NAME);
}

/**
 * @param {string} persistentStorage
 * @returns {SetupConfig | null}
 */
function init(persistentStorage) {
    storageDir = persistentStorage;
    cached = null;
    pendingNoted = undefined;
    try {
        fs.mkdirSync(storageDir, { recursive: true });
    } catch (_) { /* dir may already exist */ }

    const file = _filePath();
    if (fs.existsSync(file)) {
        try {
            cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            log.warn(`[setupConfig] corrupted ${FILE_NAME}; ignoring (${errMessage(err)})`);
            cached = null;
        }
    }
    return cached;
}

/** @returns {SetupConfig | null} */
function get() {
    return cached;
}

/**
 * What the file holds now, as the start of its next content. A noted
 * settings-form server that waited for a write is part of it.
 * @returns {SetupConfig}
 */
function _current() {
    /** @type {SetupConfig} */
    const next = { ...(cached || {}) };
    if (pendingNoted !== undefined) next.notedFormTarget = pendingNoted;
    return next;
}

/**
 * @template {SetupConfig} T
 * @param {T} next
 * @returns {T}
 */
function _write(next) {
    fs.writeFileSync(_filePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    cached = next;
    pendingNoted = undefined;
    return next;
}

/**
 * The server the settings form named while no server was chosen, or null.
 * @returns {string | null}
 */
function notedFormTarget() {
    if (pendingNoted !== undefined) return pendingNoted;
    return typeof cached?.notedFormTarget === 'string' && cached.notedFormTarget ? cached.notedFormTarget : null;
}

/**
 * Remember the server the settings form names without it being a choice, or
 * forget it (null). It is kept across restarts in setup-config.json. While
 * that file does not exist nothing is written: the value waits in memory and
 * is stored by the write that records the administrator's choice.
 * @param {string | null} target
 */
function noteFormTarget(target) {
    if (!target) {
        pendingNoted = undefined;
        if (cached && 'notedFormTarget' in cached) {
            const next = { ...cached };
            delete next.notedFormTarget;
            _write(next);
        }
        return;
    }
    if (!cached) { pendingNoted = target; return; }
    if (cached.notedFormTarget === target) { pendingNoted = undefined; return; }
    _write({ ...cached, notedFormTarget: target });
}

/**
 * @param {{ mode: string | undefined, apiBaseUrl: string | null | undefined, embedBaseUrl?: string | null }} choice
 *   embedBaseUrl: the web app (frontend) host of a self-hosted server, where the
 *   embedded app's shell is loaded from. Optional; ignored for Cloud.
 * @returns {SetupConfig & { mode: string, apiBaseUrl: string }}
 */
function save({ mode, apiBaseUrl, embedBaseUrl }) {
    if (!mode || !VALID_MODES.includes(mode)) {
        throw new Error(`invalid mode "${mode}" (allowed: ${VALID_MODES.join(', ')})`);
    }
    const url = String(apiBaseUrl || '').replace(/\/+$/, '');
    // Scheme + host validation, not just a `https?://` prefix test: this value
    // becomes the target of every signed connector→Bee Flow call, so it must
    // not be a link-local/metadata address or carry embedded credentials.
    // Synchronous (no DNS) because this is also the last gate on the settings-
    // panel path, which reconciles without a request to answer to; the routes
    // in setup.js additionally resolve the name before getting here.
    parseAllowedUrl(url, { label: 'apiBaseUrl' });
    // The shell host gets the same check: the connector fetches from it on
    // every page load and serves what it answers under the Nextcloud origin.
    const web = mode === 'cloud' ? '' : String(embedBaseUrl || '').trim().replace(/\/+$/, '');
    if (web) parseAllowedUrl(web, { label: 'Web app URL' });
    /** @type {SetupConfig & { mode: string, apiBaseUrl: string }} */
    const next = {
        ..._current(),
        mode,
        apiBaseUrl: url,
        savedAt: new Date().toISOString(),
    };
    if (web) next.embedBaseUrl = web; else delete next.embedBaseUrl;
    return _write(next);
}

/**
 * Put back the server choice that a failed switch replaced. The other fields
 * (the public Nextcloud URL) stay as they are now.
 * @param {SetupConfig | null} prev  setupConfig.get() before the switch
 */
function restoreApiChoice(prev) {
    /** @type {SetupConfig} */
    const next = _current();
    if (prev?.apiBaseUrl) {
        next.mode = prev.mode;
        next.apiBaseUrl = prev.apiBaseUrl;
    } else {
        delete next.mode;
        delete next.apiBaseUrl;
    }
    if (prev?.apiBaseUrl && prev.embedBaseUrl) next.embedBaseUrl = prev.embedBaseUrl;
    else delete next.embedBaseUrl;
    next.savedAt = new Date().toISOString();
    _write(next);
}

// Persist the admin-supplied public NC URL — the one Bee Flow Cloud uses
// to call back into this Nextcloud for ownership verification + runtime
// callbacks. Lives in the same file as the apiBaseUrl picker. `null` to
// clear (fall back to NEXTCLOUD_URL).
/**
 * @param {string | null | undefined} url
 * @returns {SetupConfig & { publicNcUrl: string | null }}
 */
function savePublicNcUrl(url) {
    const v = url ? String(url).trim().replace(/\/+$/, '') : null;
    if (v) parseAllowedUrl(v, { label: 'publicNcUrl' });
    const next = {
        ..._current(),
        publicNcUrl: v,
        savedAt: new Date().toISOString(),
    };
    return _write(next);
}

/** @returns {string | null} */
function chosenPublicNcUrl() {
    if (cached && cached.publicNcUrl) return cached.publicNcUrl;
    return null;
}

function clear() {
    const file = _filePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    cached = null;
    pendingNoted = undefined;
}

/**
 * Return the user-chosen apiBaseUrl, or null if none has been set.
 * Caller decides how to combine with the env-var fallback.
 * @returns {string | null}
 */
function chosenApiBaseUrl() {
    if (cached && cached.apiBaseUrl) return cached.apiBaseUrl;
    return null;
}

module.exports = { init, get, save, restoreApiChoice, notedFormTarget, noteFormTarget, savePublicNcUrl, clear, chosenApiBaseUrl, chosenPublicNcUrl, CLOUD_URL, CLOUD_EMBED_URL, VALID_MODES };
