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
 */

const config = require('./config');
const setupConfig = require('./setupConfig');
const { withWarmupRetry, appApiHeaders } = require('./appApiClient');
const { ocsSucceeded } = require('./ocs');
const { parseAllowedUrl } = require('./remoteHost');
const log = require('./log');
const { errMessage } = require('./errors');

const FORM_ID = 'beeflow_admin';
const FIELD_MODE = 'deployment_mode';
const FIELD_URL = 'api_base_url';
const FIELD_WEB_URL = 'web_app_url';
const POLL_INTERVAL_MS = 60_000;

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
        + 'Changes apply within ~60s; the connector re-bootstraps the tenant key automatically. '
        + 'Licence keys that unlock paid features are entered inside Bee Flow (Admin → Licence), not here.',
    doc_url: 'https://beeflow.nl',
    fields: [
        {
            id: FIELD_MODE,
            title: 'Deployment mode',
            description: 'Where the connector sends Bee Flow API requests.',
            type: 'radio',
            default: 'cloud',
            options: [
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
    if (!mode) return null;
    if (mode === 'cloud') return CLOUD_URL;
    const url = (values[FIELD_URL] || '').trim();
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

/** @type {string | null} */
let _lastApplied = null;

let _envPinLogged = false;

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
    /** @type {StoredValues} */
    let values;
    try {
        values = await _readStoredValues();
    } catch (err) {
        log.warn(`[Settings] poll failed (non-fatal): ${errMessage(err)}`);
        return;
    }
    const target = _resolveTargetUrl(values);
    if (!target) return; // self-hosted with empty URL — no-op

    const webUrl = _resolveWebUrl(values);
    const mode = values[FIELD_MODE] === 'self-hosted' ? 'self-hosted' : 'cloud';
    const fingerprint = `${mode}|${target}|${webUrl}`;
    if (fingerprint === _lastApplied) return;
    if (target === config.apiBaseUrl) {
        // Same server: nothing to re-bootstrap. Only the web app URL may have
        // changed (or this is the first poll after a restart); keep the saved
        // choice in step with the form so the shell follows it (#401).
        const stored = setupConfig.get();
        if ((stored?.embedBaseUrl || '') !== webUrl) {
            try {
                setupConfig.save({ mode, apiBaseUrl: target, embedBaseUrl: webUrl || null });
                log.info(`[Settings] web app URL for the embedded app: ${webUrl || '(the copy built into the connector)'}`);
            } catch (err) {
                log.warn(`[Settings] web app URL not saved: ${errMessage(err)}`);
                return;
            }
        }
        _lastApplied = fingerprint;
        return;
    }

    log.info(`[Settings] apiBaseUrl change requested: ${config.apiBaseUrl} → ${target}`);

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
        log.warn(`[Settings] re-bootstrap failed; keeping previous apiBaseUrl ${config.apiBaseUrl}. Detail: ${errMessage(err)}`);
    }

    if (rebootstrapOk) {
        try {
            setupConfig.save({ mode, apiBaseUrl: target, embedBaseUrl: webUrl || null });
        } catch (err) {
            log.warn(`[Settings] persistence skipped: ${errMessage(err)}`);
        }
        _lastApplied = fingerprint;
    }
    // On failure: leave _lastApplied unchanged so the next poll retries.
    // That way an admin who sets up ngrok later doesn't have to toggle
    // the radio off and on for the connector to reattempt.
}

/** @type {NodeJS.Timeout | null} */
let _pollTimer = null;

function startPolling() {
    if (_pollTimer) return;
    // Read once immediately so a value set in NC before the connector
    // started is honoured without waiting a full poll interval.
    applyStoredValuesIfChanged().catch(() => {});
    _pollTimer = setInterval(() => {
        applyStoredValuesIfChanged().catch(() => {});
    }, POLL_INTERVAL_MS);
    if (_pollTimer.unref) _pollTimer.unref();
}

function stopPolling() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

module.exports = {
    FORM_ID,
    FORM_SCHEME,
    registerSettingsForm,
    applyStoredValuesIfChanged,
    startPolling,
    stopPolling,
};
