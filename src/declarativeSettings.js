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
const { withWarmupRetry } = require('./appApiClient');

const FORM_ID = 'beeflow_admin';
const FIELD_MODE = 'deployment_mode';
const FIELD_URL = 'api_base_url';
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
    ],
};

function appApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
    };
}

async function registerSettingsForm() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui/settings`;
    const res = await withWarmupRetry(() => fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ formScheme: FORM_SCHEME }),
        signal: AbortSignal.timeout(5_000),
    }), { label: 'settings-form', budgetMs: 60_000 });
    if (!res.ok && res.status !== 409) {
        const body = await res.text().catch(() => '');
        throw new Error(`Settings form register HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log(`[Init] Declarative settings form registered (${FORM_ID})`);
}

async function _readStoredValues() {
    const url = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ex-app/config/get-values`;
    const res = await fetch(url, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ configKeys: [FIELD_MODE, FIELD_URL] }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
        throw new Error(`Read settings HTTP ${res.status}`);
    }
    const body = await res.json();
    // OCS wraps payloads as `{ ocs: { meta: {...}, data: [...] } }`. NC's
    // get-values returns an array of `{ configkey, configvalue }` pairs;
    // missing keys are simply absent rather than null.
    const data = body?.ocs?.data ?? [];
    const out = {};
    for (const row of data) {
        if (row?.configkey) out[row.configkey] = row.configvalue;
    }
    return out;
}

function _resolveTargetUrl(values) {
    // Only act when an explicit value exists in NC. Falling through to the
    // form's `default` here would silently flip a freshly-installed sandbox
    // away from its locally-passed BEEFLOW_API_BASE_URL the moment the
    // form is registered — surprising and destructive.
    const mode = values[FIELD_MODE];
    if (!mode) return null;
    if (mode === 'cloud') return CLOUD_URL;
    const url = (values[FIELD_URL] || '').trim();
    return url || null; // self-hosted picked but no URL given yet — no-op
}

let _lastApplied = null;

async function applyStoredValuesIfChanged() {
    let values;
    try {
        values = await _readStoredValues();
    } catch (err) {
        console.warn(`[Settings] poll failed (non-fatal): ${err.message}`);
        return;
    }
    const target = _resolveTargetUrl(values);
    if (!target) return; // self-hosted with empty URL — no-op

    const fingerprint = `${values[FIELD_MODE] || 'cloud'}|${target}`;
    if (fingerprint === _lastApplied) return;
    if (target === config.apiBaseUrl) {
        // First poll after restart — values match runtime, just record so we
        // don't re-bootstrap unnecessarily on the next change-detection pass.
        _lastApplied = fingerprint;
        return;
    }

    console.log(`[Settings] apiBaseUrl change requested: ${config.apiBaseUrl} → ${target}`);
    const previousUrl = config.apiBaseUrl;
    config.apiBaseUrl = target;

    // Try the new target. If bootstrap fails (e.g. Cloud picked from a
    // localhost-only sandbox NC, or a typo in the self-hosted URL), the
    // bootstrap layer rolls back its tenant key — we mirror that here by
    // restoring the previous apiBaseUrl so the next API request keeps
    // working against the old, healthy target instead of stranding the
    // user with a blank app.
    let rebootstrapOk = true;
    try {
        const bootstrap = require('./bootstrap');
        if (typeof bootstrap.invalidateAndRebootstrap === 'function') {
            await bootstrap.invalidateAndRebootstrap();
        }
    } catch (err) {
        rebootstrapOk = false;
        config.apiBaseUrl = previousUrl;
        console.warn(`[Settings] re-bootstrap failed; keeping previous apiBaseUrl ${previousUrl}. Detail: ${err.message}`);
    }

    if (rebootstrapOk) {
        try {
            setupConfig.save({
                mode: values[FIELD_MODE] === 'self-hosted' ? 'self-hosted' : 'cloud',
                apiBaseUrl: target,
            });
        } catch (err) {
            console.warn(`[Settings] persistence skipped: ${err.message}`);
        }
        _lastApplied = fingerprint;
    }
    // On failure: leave _lastApplied unchanged so the next poll retries.
    // That way an admin who sets up ngrok later doesn't have to toggle
    // the radio off and on for the connector to reattempt.
}

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
