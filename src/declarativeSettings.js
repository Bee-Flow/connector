/**
 * NC admin settings panel for Bee Flow — Cloud vs self-hosted picker.
 *
 * Registers a Declarative Settings form via AppAPI so the admin gets a
 * proper section under /settings/admin/ai (Artificial Intelligence) instead
 * of having to remember the connector's hidden /setup URL.
 *
 * AppAPI's listener (lib/Listener/DeclarativeSettings/SetValueListener.php)
 * persists values to NC's `oc_ex_apps_appconfig_ex` table. NC does NOT
 * push the change to the running ExApp — we poll the same table via OCS
 * every POLL_INTERVAL_MS and reconcile against the connector's own
 * setupConfig. When a change is detected, we invalidate the cached tenant
 * key and trigger a fresh bootstrap so the SPA's next request lands on
 * the new SaaS target.
 *
 * The form never makes the choice of a server by itself. Its default is
 * "No change", and while no server is chosen the server the form names at the
 * first poll after a start is only noted: it counts as a choice once the form
 * names another one. A noted server stays without effect after a choice on the
 * setup page and across restarts (it is kept in setup-config.json next to that
 * choice). What is compared is the server the form resolves to, so an edit to a
 * field that does not change that server is not a choice either. A first
 * choice asks the address for /api/health before anything is saved or sent,
 * like the setup page does.
 */

const config = require('./config');
const setupConfig = require('./setupConfig');
const { withWarmupRetry, appApiHeaders } = require('./appApiClient');
const { ocsSucceeded } = require('./ocs');
const { parseAllowedUrl } = require('./remoteHost');
const log = require('./log');
const { errMessage } = require('./errors');
const { probe } = require('./serverProbe');
const { SETTINGS_FORM_CONSENT } = require('./setupTexts');

const FORM_ID = 'beeflow_admin';
const FIELD_MODE = 'deployment_mode';
const FIELD_URL = 'api_base_url';
const FIELD_WEB_URL = 'web_app_url';
const POLL_INTERVAL_MS = 60_000;
// The radio value that asks for nothing: the connection stays as it is.
const MODE_KEEP = 'keep';

const CLOUD_URL = setupConfig.CLOUD_URL;

const FORM_SCHEME = {
    id: FORM_ID,
    priority: 50,
    section_type: 'admin',
    section_id: 'ai', // Lives under /settings/admin/ai (Artificial Intelligence)
    storage_type: 'external',
    title: 'Bee Flow',
    description: 'Choose between the hosted Bee Flow service (Cloud) and your own self-hosted Bee Flow server. '
        + 'To self-host, run a Bee Flow server (see beeflow.nl/docs → Self-hosting; e.g. ./selfhost.sh) and enter its URL below. '
        + `${SETTINGS_FORM_CONSENT} `
        + 'A change to another server applies within about a minute; the connector then connects to that server by itself. '
        + 'Licence keys that unlock paid features are entered inside Bee Flow (Admin → Licence), not here.',
    doc_url: 'https://beeflow.nl',
    fields: [
        {
            id: FIELD_MODE,
            title: 'Deployment mode',
            description: 'Where the connector sends Bee Flow API requests.',
            type: 'radio',
            default: MODE_KEEP,
            options: [
                { name: 'No change (keep the current connection)', value: MODE_KEEP },
                { name: `Bee Flow Cloud (${CLOUD_URL})`, value: 'cloud' },
                { name: 'Self-hosted server', value: 'self-hosted' },
            ],
        },
        {
            id: FIELD_URL,
            title: 'Self-hosted API URL',
            description: 'Only used when "Self-hosted server" is selected. The base URL of your Bee Flow server '
                + '(the SERVER address, not the web UI). Must be reachable from this Nextcloud. '
                + 'Example: https://bee-flow.your-domain.com or http://bee-flow-server:3001',
            type: 'url',
            default: '',
            placeholder: 'https://bee-flow.your-domain.com',
        },
        {
            id: FIELD_WEB_URL,
            title: 'Self-hosted web app URL (optional)',
            description: 'The address of your Bee Flow web app (the frontend, not the server). The app inside '
                + 'Nextcloud is then loaded from there, so it is always the same version as your server. '
                + 'Leave empty to use the copy built into the connector. Nothing is loaded from beeflow.nl.',
            type: 'url',
            default: '',
            placeholder: 'https://app.your-domain.com',
        },
    ],
};

async function registerSettingsForm() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui/settings`;
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ formScheme: FORM_SCHEME }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'settings-form', budgetMs: 60_000 });
    // OCS answers HTTP 200 even when it refuses the form — check
    // ocs.meta.statuscode too, or a rejected registration logs as success.
    const body = await res.text().catch(() => '');
    const { ok, code } = ocsSucceeded(res, body, 'POST');
    if (!ok) {
        throw new Error(`Settings form register HTTP ${res.status}${code === null ? '' : ` / OCS ${code}`}: ${body.slice(0, 200)}`);
    }
    log.info(`[Init] Declarative settings form registered (${FORM_ID})`);
}

/**
 * The two appconfig keys this panel owns, by key.
 * @typedef {Record<string, string | undefined>} StoredValues
 */

/** @returns {Promise<StoredValues>} */
async function _readStoredValues() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ex-app/config/get-values`;
    const res = await fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ configKeys: [FIELD_MODE, FIELD_URL, FIELD_WEB_URL] }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
        throw new Error(`Read settings HTTP ${res.status}`);
    }
    const body = /** @type {{ ocs?: { data?: { configkey?: string, configvalue?: string }[] } } | null} */ (await res.json());
    // OCS wraps payloads as `{ ocs: { meta: {...}, data: [...] } }`. NC's
    // get-values returns an array of `{ configkey, configvalue }` pairs;
    // missing keys are simply absent rather than null.
    const data = body?.ocs?.data ?? [];
    /** @type {StoredValues} */
    const out = {};
    for (const row of data) {
        if (row?.configkey) out[row.configkey] = row.configvalue;
    }
    return out;
}

/**
 * @param {StoredValues} values
 * @returns {string | null}
 */
function _resolveTargetUrl(values) {
    // Only act when an explicit value exists in NC. Falling through to the
    // form's `default` here would silently flip a freshly-installed sandbox
    // away from its locally-passed BEEFLOW_API_BASE_URL the moment the
    // form is registered — surprising and destructive.
    const mode = values[FIELD_MODE];
    if (!mode || mode === MODE_KEEP) return null;
    if (mode === 'cloud') return CLOUD_URL;
    // Without trailing slashes, the way the connector keeps every server
    // address: the same server typed with a slash is the same server.
    const url = (values[FIELD_URL] || '').trim().replace(/\/+$/, '');
    if (!url) return null; // self-hosted picked but no URL given yet — no-op
    // This value arrives from Nextcloud's appconfig, i.e. straight from a text
    // field in the admin settings panel — the same untrusted-input class as a
    // request body, and the connector signs every SaaS call to whatever it says.
    try {
        parseAllowedUrl(url, { label: 'Self-hosted API URL' });
    } catch (err) {
        log.warn(`[Settings] ignoring the configured Bee Flow server URL: ${errMessage(err)}`);
        return null;
    }
    return url;
}

/**
 * The self-hosted web app URL from the form, or '' (none, invalid, or Cloud).
 * @param {StoredValues} values
 * @returns {string}
 */
function _resolveWebUrl(values) {
    if (values[FIELD_MODE] !== 'self-hosted') return '';
    const url = (values[FIELD_WEB_URL] || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    try {
        parseAllowedUrl(url, { label: 'Self-hosted web app URL' });
    } catch (err) {
        log.warn(`[Settings] ignoring the configured web app URL: ${errMessage(err)}`);
        return '';
    }
    return url;
}

/**
 * Do two addresses name the same server? Compared the way a browser reads
 * them: the host in any case, the default port written or not, with or
 * without a trailing slash.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameAddress(a, b) {
    /** @param {string} value */
    const key = (value) => {
        try {
            const u = new URL(value);
            return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
        } catch {
            return String(value).replace(/\/+$/, '');
        }
    };
    return key(a) === key(b);
}

/** @type {string | null} */
let _lastApplied = null;

let _envPinLogged = false;

// The server the form names without it being a choice. `undefined`: no poll
// read the form yet. A string: the server the form named at the first poll of
// a start without a server ('' when it named none), or the one setup-config.json
// keeps from such a start; it is not a choice until the form names another.
// `null`: nothing is noted, the form is followed.
/** @type {string | null | undefined} */
let _noted;
/** @type {boolean | undefined} */
let _baselineWanted;

// The form value whose address did not answer as a Bee Flow server, so the
// warning is logged once and not at every poll.
/** @type {string | null} */
let _probeFailureLogged = null;

// The form value of a switch that did not happen. The form keeps naming it, so
// every poll comes back to it: the switch is tried again once a Bee Flow server
// answers at that address, and until then the connection in use is left alone.
/** @type {string | null} */
let _rejectedSwitch = null;
// The server that switch was about.
/** @type {string | null} */
let _rejectedTarget = null;

/**
 * The form no longer asks for the switch that did not happen: nothing waits
 * for that server any more, and the diagnostics stop reporting it.
 */
function _withdrawRejectedSwitch() {
    if (_rejectedTarget) require('./bootstrap').withdrawRejectedSwitch(_rejectedTarget);
    _rejectedSwitch = null;
    _rejectedTarget = null;
}

/**
 * Is the server the form names (`target`, null for none) only noted? Decides
 * it at the first read after a start, and lifts it once the form names
 * another server.
 * @param {string | null} target
 * @returns {boolean}
 */
function _isNoted(target) {
    const named = (target || '').replace(/\/+$/, '');
    if (_noted === undefined) {
        if (_baselineWanted) {
            // No server chosen at this start: whatever the form names now is
            // noted, and kept for the starts after a choice on the setup page.
            _noted = named;
            _keepNoted(named || null);
            // This read can come after a choice on the setup page (the read at
            // the start failed and this is the next one): the line says what
            // holds at the moment it is written.
            log.info(config.apiBaseUrl
                ? '[Settings] the values the settings form holds are noted; they count as a choice once they are changed.'
                : '[Settings] no Bee Flow server is chosen; the values in the settings form count as a choice once they are changed.');
            return true;
        }
        _noted = setupConfig.notedFormTarget();
    }
    if (_noted === null) return false;
    if (named === _noted) return true;
    _noted = null;
    _keepNoted(null);
    return false;
}

/** @param {string | null} target */
function _keepNoted(target) {
    try {
        setupConfig.noteFormTarget(target);
    } catch (err) {
        log.warn(`[Settings] the noted form value was not saved: ${errMessage(err)}`);
    }
}

async function applyStoredValuesIfChanged() {
    // Precedence: a BEEFLOW_API_BASE_URL naming a server other than Cloud is
    // a deliberate admin lock (config.apiBaseUrlLocked; AppAPI always injects
    // the Cloud default, which is not a lock) and wins over the picker — the same rule bootstrap and
    // server.js already enforce (server.js only applies a stored apiBaseUrl
    // when the env is unset). Without this guard the poll fought the env pin:
    // it kept trying to switch to the stored value every interval, and each
    // attempt invalidated the tenant key before failing and rolling back —
    // e.g. a `http://localhost:3001` typed into the form on a box whose
    // container reaches the host at a LAN IP, which strands the app keyless
    // for the width of every retry.
    if (config.apiBaseUrlLocked) {
        if (!_envPinLogged) {
            log.info(`[Settings] BEEFLOW_API_BASE_URL is set (${process.env.BEEFLOW_API_BASE_URL}) — the admin picker is informational and will not repoint the connector.`);
            _envPinLogged = true;
        }
        return;
    }
    // Decided at the first poll, before the read: a read that fails does not
    // turn a later one into something else than the first.
    if (_baselineWanted === undefined) _baselineWanted = !config.apiBaseUrl;
    /** @type {StoredValues} */
    let values;
    try {
        values = await _readStoredValues();
    } catch (err) {
        log.warn(`[Settings] poll failed (non-fatal): ${errMessage(err)}`);
        return;
    }
    // No server chosen at the first poll after a start: the server the form
    // names at that moment is noted, not acted on. Only when the form names
    // another server is that a choice; the noted one stays without effect
    // until then, also once a server is chosen on the setup page and after a
    // restart.
    const target = _resolveTargetUrl(values);
    if (_isNoted(target)) return;
    const webUrl = _resolveWebUrl(values);
    const mode = values[FIELD_MODE] === 'self-hosted' ? 'self-hosted' : 'cloud';
    const fingerprint = target ? `${mode}|${target}|${webUrl}` : null;
    // The form named a server the connector did not switch to, and names
    // something else now ("No change", the server in use, another server):
    // that request is withdrawn.
    if (_rejectedSwitch && _rejectedSwitch !== fingerprint) _withdrawRejectedSwitch();
    if (!target) return; // "No change", or self-hosted with an empty URL — no-op
    if (fingerprint === _lastApplied) return;

    // A first choice: is there a Bee Flow server at that address? Until one
    // answers, nothing is saved and nothing about this Nextcloud is sent; the
    // next poll asks again.
    if (!config.apiBaseUrl) {
        const health = await probe(target);
        if (!health.ok) {
            if (_probeFailureLogged !== fingerprint) {
                log.warn(`[Settings] no Bee Flow server answers at ${target} (${health.error}); nothing is saved and no server is chosen.`);
                _probeFailureLogged = fingerprint;
            }
            return;
        }
        _probeFailureLogged = null;
    }

    if (config.apiBaseUrl && sameAddress(target, config.apiBaseUrl)) {
        // Same server: nothing to re-bootstrap. Only the web app URL may have
        // changed (or this is the first poll after a restart); keep the saved
        // choice in step with the form so the shell follows it (#401).
        const stored = setupConfig.get();
        if ((stored?.embedBaseUrl || '') !== webUrl) {
            try {
                setupConfig.save({ mode, apiBaseUrl: config.apiBaseUrl, embedBaseUrl: webUrl || null });
                log.info(`[Settings] web app URL for the embedded app: ${webUrl || '(the copy built into the connector)'}`);
            } catch (err) {
                log.warn(`[Settings] web app URL not saved: ${errMessage(err)}`);
                return;
            }
        }
        _lastApplied = fingerprint;
        return;
    }

    if (_rejectedSwitch === fingerprint) {
        const health = await probe(target);
        if (!health.ok) return;
    }

    log.info(`[Settings] apiBaseUrl change requested: ${config.apiBaseUrl || '(not chosen)'} → ${target}`);

    // Try the new target. If bootstrap fails (e.g. Cloud picked from a
    // localhost-only sandbox NC, or a typo in the self-hosted URL), the
    // bootstrap layer rolls back the key AND the server URL, so the next API
    // request keeps working against the old, healthy target. A server that
    // wants the emailed code first counts as applied: the switch is pending
    // on that server, and polling again would only open another pending
    // binding there every minute (until it answers 429).
    let rebootstrapOk = true;
    try {
        await require('./bootstrap').invalidateAndRebootstrap({ apiBaseUrl: target });
    } catch (err) {
        rebootstrapOk = false;
        log.warn(`[Settings] re-bootstrap failed; the connector is on ${config.apiBaseUrl || '(no server)'}. Detail: ${errMessage(err)}`);
    }

    // A first choice stays chosen when connecting to it failed (see
    // bootstrap.invalidateAndRebootstrap): it is saved like an applied one, and
    // the bootstrap's own retry takes it from there, not this poll.
    const firstChoiceKept = !rebootstrapOk && config.apiBaseUrl === target;
    if (rebootstrapOk || firstChoiceKept) {
        try {
            setupConfig.save({ mode, apiBaseUrl: target, embedBaseUrl: webUrl || null });
        } catch (err) {
            log.warn(`[Settings] persistence skipped: ${errMessage(err)}`);
        }
        _lastApplied = fingerprint;
        _rejectedSwitch = null;
        _rejectedTarget = null;
        return;
    }
    // On a failed switch: leave _lastApplied unchanged so a later poll retries.
    // That way an admin who sets up ngrok later doesn't have to toggle
    // the radio off and on for the connector to reattempt. The retry waits for
    // a Bee Flow server to answer at that address (see _rejectedSwitch).
    if (_rejectedSwitch !== fingerprint) {
        log.warn(`[Settings] the settings form still names ${target}; the switch is tried again once a Bee Flow server answers there.`);
    }
    _rejectedSwitch = fingerprint;
    _rejectedTarget = target;
}

/** @type {NodeJS.Timeout | null} */
let _pollTimer = null;

/**
 * Start the poll. The first read does not wait a full interval, so a value
 * set in Nextcloud while the connector was down is honoured at once. It does
 * wait for the bootstrap of this start: a switch then begins from the binding
 * the install holds (its key loaded from disk), which is what the switch signs
 * with and what it goes back to when the new server does not bind.
 * @returns {Promise<void>} settles when that first read has been applied
 */
function startPolling() {
    if (_pollTimer) return Promise.resolve();
    const first = require('./bootstrap').bootstrapIfNeeded()
        .catch(() => {}) // reported and retried by the bootstrap itself
        .then(() => applyStoredValuesIfChanged())
        .catch(() => {});
    _pollTimer = setInterval(() => {
        applyStoredValuesIfChanged().catch(() => {});
    }, POLL_INTERVAL_MS);
    if (_pollTimer.unref) _pollTimer.unref();
    return first;
}

function stopPolling() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

/** Back to the state right after a start (tests). */
function _resetForTests() {
    _lastApplied = null;
    _envPinLogged = false;
    _noted = undefined;
    _baselineWanted = undefined;
    _probeFailureLogged = null;
    _rejectedSwitch = null;
    _rejectedTarget = null;
}

module.exports = {
    FORM_ID,
    FORM_SCHEME,
    registerSettingsForm,
    applyStoredValuesIfChanged,
    startPolling,
    stopPolling,
    _resetForTests,
};
