/**
 * Bee Flow as a Nextcloud Task Processing provider.
 *
 * Task Processing (`OCP\TaskProcessing`, Nextcloud 30+) is the single API every
 * AI feature in Nextcloud routes through: Assistant, Mail thread summaries,
 * Talk summaries, Text, Collectives, Notes, Deck and Office all schedule tasks
 * and let whichever provider is registered do the work. Registering here means
 * a Nextcloud admin gets all of it running on Bee Flow — EU-hosted, with the
 * organisation's own model choice and Privacy Shield in front of it — by
 * installing one ExApp, with nothing to configure per feature.
 *
 * That is worth stating plainly because Nextcloud's own Ethical AI Rating table
 * scores `integration_openai` **Red** (closed model, closed weights, closed
 * training data). This is the alternative that keeps the data on-premise.
 *
 * ── How the lifecycle actually works ────────────────────────────────────────
 * AppAPI wraps an ExApp provider in an `ITriggerableProvider` shim, so:
 *
 *   1. We POST a provider definition to
 *      `/apps/app_api/api/v1/ai_provider/task_processing`, one per task type.
 *   2. When a task is scheduled for one of them and nothing is already running,
 *      Nextcloud calls this ExApp at `GET /trigger?providerId=<id>`.
 *   3. We pull work with `GET /taskprocessing/tasks_provider/next`, run it
 *      through the Bee Flow SaaS, and report back with
 *      `POST /taskprocessing/tasks_provider/{id}/result`.
 *
 * Step 2 is why there is no polling loop here. Before `ITriggerableProvider`
 * (NC 33) ExApps had to poll; being triggered instead is the difference between
 * an idle container and one waking a background job every few seconds. We do
 * keep draining in a loop *after* a trigger, because the trigger only fires
 * when the queue transitions from empty — a burst of tasks produces one call.
 */

const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const REGISTER_API = '/ocs/v2.php/apps/app_api/api/v1/ai_provider/task_processing';
const TP_API = '/ocs/v2.php/taskprocessing';

const PROVIDER_PREFIX = 'bee_flow';

/**
 * Task types we implement. Each becomes one registered provider.
 *
 * Deliberately limited to the text-shaped types: those are what the Bee Flow
 * SaaS serves today through its existing provider factory
 * (`server/core/providers/index.js`). See the note below the list for what is
 * left out and why — the rule is that a provider which errors on every task is
 * worse for the user than no provider, because Nextcloud still routes to it.
 *
 * `expectedRuntime` is in seconds and only drives the "expected completion"
 * hint Nextcloud shows; it does not time anything out.
 */
const TASK_TYPES = [
    { id: 'core:text2text', name: 'Bee Flow', expectedRuntime: 30 },
    { id: 'core:text2text:chat', name: 'Bee Flow (chat)', expectedRuntime: 30 },
    { id: 'core:text2text:summary', name: 'Bee Flow (summary)', expectedRuntime: 30 },
    { id: 'core:text2text:headline', name: 'Bee Flow (headline)', expectedRuntime: 15 },
    { id: 'core:text2text:topics', name: 'Bee Flow (topics)', expectedRuntime: 15 },
    { id: 'core:text2text:proofread', name: 'Bee Flow (proofread)', expectedRuntime: 20 },
    { id: 'core:text2text:reformulation', name: 'Bee Flow (reformulate)', expectedRuntime: 20 },
    { id: 'core:text2text:simplification', name: 'Bee Flow (simplify)', expectedRuntime: 20 },
    { id: 'core:text2text:formalization', name: 'Bee Flow (formalise)', expectedRuntime: 20 },
    { id: 'core:text2text:improve', name: 'Bee Flow (improve)', expectedRuntime: 20 },
    { id: 'core:text2text:translate', name: 'Bee Flow (translate)', expectedRuntime: 20 },
];

// NOT registered, on purpose:
//   core:audio2text — Bee Flow transcribes with WhisperX (which does speaker
//     diarisation, unlike Nextcloud's stt_whisper2), but that runs on a
//     different pipeline and takes a Nextcloud file id rather than text.
//     Until the SaaS side of that exists, registering it would make Nextcloud
//     route every transcription to a provider that fails.
//   core:text2image, core:text2speech — same reasoning.
// The rule is the one in the header: a provider that errors on every task is
// worse for the user than no provider, because Nextcloud still routes to it.

function providerId(taskTypeId) {
    // Provider ids must be unique per instance; namespacing by app id keeps us
    // from colliding with llm2 or integration_openai when several are enabled.
    return `${PROVIDER_PREFIX}:${taskTypeId}`;
}

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

function providerDefinition(taskType) {
    return {
        id: providerId(taskType.id),
        name: taskType.name,
        task_type: taskType.id,
        expected_runtime: taskType.expectedRuntime,
        // We add no inputs or outputs beyond what each task type already
        // defines. Optional shapes are where a provider would expose
        // model-specific knobs; keeping them empty means Bee Flow is a
        // drop-in for whatever provider the admin had before.
        optional_input_shape: [],
        optional_output_shape: [],
        input_shape_defaults: [],
        optional_input_shape_defaults: [],
        input_shape_enum_values: [],
        optional_input_shape_enum_values: [],
        output_shape_enum_values: [],
        optional_output_shape_enum_values: [],
    };
}

let _registered = false;

/** Register one provider per task type. Idempotent. */
async function registerTaskProcessing() {
    if (!config.tenantKey) {
        // Without a tenant key we cannot execute anything, and a provider that
        // fails every task is worse than no provider — Nextcloud would still
        // route to it. Register only once bootstrap has completed.
        return { ok: false, reason: 'no-tenant-key', registered: 0 };
    }

    const url = `${config.nextcloudUrl}${REGISTER_API}`;
    const results = await Promise.allSettled(TASK_TYPES.map(async (taskType) => {
        const res = await withWarmupRetry(() => fetch(url, {
            method: 'POST',
            headers: appApiHeaders(),
            body: JSON.stringify({ provider: providerDefinition(taskType), customTaskType: null }),
            signal: AbortSignal.timeout(5_000),
        }), { label: `tp-${taskType.id}`, budgetMs: 20_000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return taskType.id;
    }));

    const registered = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - registered;
    if (registered > 0) _registered = true;
    console.log(`[TaskProcessing] ${registered}/${TASK_TYPES.length} providers registered`
        + (failed ? ` (${failed} failed — Nextcloud may predate the Task Processing API)` : ''));
    return { ok: failed === 0, registered, failed };
}

async function unregisterTaskProcessing() {
    if (!config.nextcloudUrl || !_registered) return;
    const url = `${config.nextcloudUrl}${REGISTER_API}`;
    await Promise.allSettled(TASK_TYPES.map(t => fetch(url, {
        method: 'DELETE',
        headers: appApiHeaders(),
        body: JSON.stringify({ name: providerId(t.id) }),
        signal: AbortSignal.timeout(2_000),
    }).catch(() => {})));
}

// ── Task execution ──────────────────────────────────────────────────────────

async function fetchNextTask(id) {
    const params = new URLSearchParams();
    params.append('providerIds[]', id);
    // The task type is implied by the provider, but the endpoint wants both.
    const taskType = TASK_TYPES.find(t => providerId(t.id) === id);
    if (taskType) params.append('taskTypeIds[]', taskType.id);
    const res = await fetch(`${config.nextcloudUrl}${TP_API}/tasks_provider/next?${params.toString()}`, {
        headers: appApiHeaders(),
        signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null; // nothing queued
    if (!res.ok) throw new Error(`next task HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    return body?.ocs?.data?.task || null;
}

async function reportResult(taskId, { output, errorMessage, userFacingErrorMessage }) {
    const payload = {};
    if (output) payload.output = output;
    if (errorMessage) payload.errorMessage = errorMessage;
    if (userFacingErrorMessage) payload.userFacingErrorMessage = userFacingErrorMessage;
    await fetch(`${config.nextcloudUrl}${TP_API}/tasks_provider/${encodeURIComponent(taskId)}/result`, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
    }).catch(err => console.warn(`[TaskProcessing] could not report result for ${taskId}: ${err.message}`));
}

/**
 * Hand a task to the Bee Flow SaaS.
 *
 * Signed with the tenant key over the body, the same scheme every other
 * connector→SaaS call uses. `taskType` travels alongside the input so the SaaS
 * can pick the right prompt without re-deriving it from shapes.
 */
async function executeViaSaaS(task) {
    const crypto = require('crypto');
    const path = '/api/nextcloud/task-processing/execute';
    const body = JSON.stringify({
        taskType: task.type,
        input: task.input || {},
        ncUid: task.userId || null,
        customId: task.customId || null,
        appId: task.appId || null,
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nPOST\n${path}\n${body}`).digest('hex');

    const res = await fetch(`${config.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': config.ncInstanceId,
            'X-Beeflow-Sig': `${ts}.${sig}`,
        },
        body,
        // Generous: a long summary on a busy model can legitimately take minutes.
        signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bee Flow returned ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data.output !== 'object') {
        throw new Error('Bee Flow returned no output');
    }
    return data.output;
}

/**
 * Drain every queued task for one provider.
 *
 * Loops rather than handling one: Nextcloud only triggers when the queue goes
 * from empty to non-empty, so a burst of ten tasks produces a single call and
 * the other nine would sit until something else woke us.
 */
async function drainProvider(id) {
    let handled = 0;
    // Bounded so a task that immediately re-queues cannot spin forever.
    while (handled < 50) {
        let task;
        try {
            task = await fetchNextTask(id);
        } catch (err) {
            console.warn(`[TaskProcessing] could not fetch next task for ${id}: ${err.message}`);
            return handled;
        }
        if (!task) return handled;

        handled += 1;
        try {
            const output = await executeViaSaaS(task);
            await reportResult(task.id, { output });
        } catch (err) {
            // Two messages on purpose: Nextcloud shows the user-facing one and
            // keeps the detailed one for admins. Never leak the SaaS URL or
            // status text to an end user.
            console.warn(`[TaskProcessing] task ${task.id} failed: ${err.message}`);
            await reportResult(task.id, {
                errorMessage: err.message,
                userFacingErrorMessage: 'Bee Flow could not complete this request. Please try again, or contact your administrator if it keeps happening.',
            });
        }
    }
    return handled;
}

function registerRoutes(app) {
    // Nextcloud calls this when a task is scheduled for one of our providers.
    // Answer immediately and drain in the background: AppAPI's request has its
    // own timeout, and holding it open for the length of an LLM call would make
    // every trigger look like a failure.
    app.get('/trigger', (req, res) => {
        const id = String(req.query.providerId || '');
        res.json({ status: 'ok' });
        if (!id) return;
        setImmediate(() => {
            drainProvider(id).catch(err =>
                console.warn(`[TaskProcessing] drain failed for ${id}: ${err.message}`));
        });
    });
}

module.exports = {
    registerTaskProcessing,
    unregisterTaskProcessing,
    registerRoutes,
    drainProvider,
    providerId,
    providerDefinition,
    TASK_TYPES,
};
