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
 * Step 2 is the primary wake-up, but it is NOT sufficient on its own, and this
 * used to be the whole story here. `Manager.php` suppresses the trigger
 * whenever a task of that type is already running:
 *
 *     if (!$this->taskMapper->hasRunningTasksForTaskType($task->getTaskTypeId()))
 *
 * so the second concurrent user of a task type generates no call at all, and
 * their task waits for whatever happens to arrive next. `context_agent` keeps
 * an idle poll for exactly this reason, and so do we — fast while there is
 * work, backing off to five minutes when there is not. The trigger stays: it
 * is what makes the first task of a burst instant instead of poll-latency.
 *
 * We also keep draining in a loop after each wake-up, because the trigger only
 * fires when the queue transitions from empty — a burst produces one call.
 */

const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const REGISTER_API = '/ocs/v2.php/apps/app_api/api/v1/ai_provider/task_processing';
const TP_API = '/ocs/v2.php/taskprocessing';

const PROVIDER_PREFIX = 'bee_flow';

// Nextcloud's OCP\TaskProcessing\EShapeType, by its integer backing value.
// AppAPI's provider registration validates each shape entry as
// { name, description, shape_type:<int> } — passing the PHP enum's *name*
// (e.g. 'ListOfTexts') is rejected with HTTP 400 "should be an array and must
// have name, description and shape_type keys", which silently dropped the one
// provider that has a non-empty shape (the agent) and left the Assistant with
// "No provider found". Keep in sync with
// https://github.com/nextcloud/server/blob/master/lib/public/TaskProcessing/EShapeType.php
const EShapeType = {
    Number: 0, Text: 1, Image: 2, Audio: 3, Video: 4, File: 5, Enum: 6,
    ListOfNumbers: 10, ListOfTexts: 11, ListOfImages: 12,
    ListOfAudios: 13, ListOfVideos: 14, ListOfFiles: 15,
};

/**
 * Task types we implement. Each becomes one registered provider.
 *
 * Deliberately limited to the text-shaped types: those are what the Bee Flow
 * SaaS serves today through its existing provider factory
 * (`server/core/providers/index.js`). See the note below the list for what is
 * left out and why — the rule is that a provider which errors on every task is
 * worse for the user than no provider, because Nextcloud still routes to it.
 *
 * `expectedRuntime` is in seconds. Nextcloud uses it only for the "expected
 * completion" hint and times nothing out on its own — so we also derive our own
 * watchdog deadline from it (see watchdogMsFor). Keep it roughly honest per
 * type: too low and slow-but-fine answers get killed, too high and a hung SaaS
 * leaves the user on a spinner for longer than they will wait.
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
    // ── The agent ────────────────────────────────────────────────────────────
    // This one type is the whole Assistant experience. Nextcloud's Assistant
    // decides whether to show its agent tab, its confirmation dialog and its
    // chat history from exactly one expression:
    //
    //   $agencyAvailable = class_exists(...)
    //       && array_key_exists(ContextAgentInteraction::ID, $manager->getAvailableTaskTypes())
    //
    // and getAvailableTaskTypes() returns a type as soon as ANY provider claims
    // it. ContextAgentInteraction implements IInternalTaskType, which reads like
    // a wall but is not one: that interface appears in Manager.php only to set
    // `'isInternal'` in an API response. It gates nothing. So an ordinary,
    // unprivileged ExApp registration puts Bee Flow behind the agent — with the
    // user id arriving on the task record, so tool calls run as the right
    // person.
    //
    // 60s because an agent turn does real work; the watchdog clamps at 5 min.
    {
        id: 'core:contextagent:interaction',
        name: 'Bee Flow (agent)',
        expectedRuntime: 60,
        // Assistant reads optionalInputShape['memories'] to decide whether it
        // may pass prior context, so declaring it is what turns that on.
        optionalInputShape: [{ name: 'memories', description: 'Relevant prior context', shape_type: EShapeType.ListOfTexts }],
        optionalOutputShape: [{ name: 'sources', description: 'Sources used to answer', shape_type: EShapeType.ListOfTexts }],
    },
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
        // Empty for the text types on purpose: optional shapes are where a
        // provider exposes model-specific knobs, and keeping them empty means
        // Bee Flow is a drop-in for whatever provider the admin had before.
        // The agent type declares its own — Assistant inspects them to decide
        // what it may send us.
        optional_input_shape: taskType.optionalInputShape || [],
        optional_output_shape: taskType.optionalOutputShape || [],
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
        if (!res.ok) {
            // Carry the response body: a failed registration is almost always
            // Nextcloud rejecting one specific provider (unknown task type,
            // malformed shape), and "1 failed" with no id told nobody which one
            // or why — which for the agent type is the difference between the
            // Assistant showing its chat and showing "No provider found".
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
        }
        return taskType.id;
    }));

    const registered = results.filter(r => r.status === 'fulfilled').length;
    const failures = results
        .map((r, i) => ({ r, id: TASK_TYPES[i].id }))
        .filter(x => x.r.status === 'rejected');
    const failed = failures.length;
    if (registered > 0) _registered = true;
    console.log(`[TaskProcessing] ${registered}/${TASK_TYPES.length} providers registered`
        + (failed ? ` (${failed} failed)` : ''));
    for (const { id, r } of failures) {
        console.warn(`[TaskProcessing] provider '${id}' failed to register: ${r.reason?.message || r.reason}`);
    }
    return { ok: failed === 0, registered, failed, failedIds: failures.map(f => f.id) };
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
/**
 * How long we let one task run before giving up on it.
 *
 * Nextcloud will NOT time our task out. `MAX_TASK_AGE_SECONDS` in its
 * TaskProcessing Manager is six months, and a task we never report on simply
 * stays SCHEDULED — the user gets a spinner that hangs until someone runs
 * `occ taskprocessing:*`. So the deadline has to be ours, and it has to end in
 * a reported failure rather than a dropped promise.
 *
 * Derived from the type's own `expectedRuntime` so a 15-second headline is not
 * held for the same five minutes as a long summary, and clamped so neither a
 * mis-declared runtime nor a future type can produce an absurd deadline.
 */
const WATCHDOG_FACTOR = 6;
const WATCHDOG_MIN_MS = 60_000;
const WATCHDOG_MAX_MS = 5 * 60 * 1000;

function watchdogMsFor(taskTypeId) {
    const t = TASK_TYPES.find(x => x.id === taskTypeId);
    const derived = (t?.expectedRuntime ?? 30) * WATCHDOG_FACTOR * 1000;
    return Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, derived));
}

/**
 * What the END USER sees when a task fails, by cause.
 *
 * One hard-coded sentence used to cover every failure, which told a user
 * nothing about whether to retry, wait, or fetch an administrator.
 *
 * NOT LOCALISED, and that is a known gap rather than an oversight: the task
 * record Nextcloud hands us carries no locale, and guessing from the instance
 * default would be wrong for exactly the multilingual organisations this
 * integration is aimed at. Wiring a real locale — from the task, or from a
 * per-user lookup on failure — is the fix; until then these stay English and
 * stay short, because a long English sentence is worse than a short one for
 * someone who does not read it.
 */
const USER_ERRORS = {
    timeout: 'Bee Flow took too long to answer this request. Please try again — if it keeps happening, ask your administrator to check the Bee Flow connection.',
    upstream: 'Bee Flow could not complete this request. Please try again, or contact your administrator if it keeps happening.',
    unconfigured: 'Bee Flow is not finished setting up on this server yet. Please ask your administrator to check the Bee Flow app settings.',
};

async function executeViaSaaS(task, { timeoutMs } = {}) {
    const crypto = require('crypto');
    const path = '/api/nextcloud/task-processing/execute';
    const body = JSON.stringify({
        taskType: task.type,
        input: task.input || {},
        ncUid: task.userId || null,
        customId: task.customId || null,
        appId: task.appId || null,
    });
    // `task.userId` is the reason the agent belongs on this path rather than
    // behind MCP: Nextcloud's mcp_config is instance-wide appconfig, so an
    // MCP-based agent would run every user's tool calls as one Bee Flow
    // identity. The task record carries the real user, for free.
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
        signal: AbortSignal.timeout(timeoutMs ?? WATCHDOG_MAX_MS),
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

/** Run one task to completion and report the outcome, whatever it is. */
async function runTask(task) {
    const timeoutMs = watchdogMsFor(task.type);
    try {
        const output = await executeViaSaaS(task, { timeoutMs });
        await reportResult(task.id, { output });
    } catch (err) {
        // AbortSignal.timeout rejects with a TimeoutError; anything else is the
        // SaaS answering badly. The distinction is the difference between "wait
        // and retry" and "something is broken", so the user gets to know which.
        const timedOut = err?.name === 'TimeoutError' || /aborted|timeout/i.test(err?.message || '');
        // Two messages on purpose: Nextcloud shows the user-facing one and
        // keeps the detailed one for admins. Never leak the SaaS URL or status
        // text to an end user.
        console.warn(`[TaskProcessing] task ${task.id} (${task.type}) failed after `
            + `${timedOut ? `${timeoutMs}ms watchdog` : 'upstream error'}: ${err.message}`);
        await reportResult(task.id, {
            errorMessage: timedOut ? `Bee Flow watchdog fired after ${timeoutMs}ms: ${err.message}` : err.message,
            userFacingErrorMessage: timedOut ? USER_ERRORS.timeout : USER_ERRORS.upstream,
        });
    }
}

// Tasks in flight per provider. One at a time meant an organisation queued
// behind whoever asked first — tolerable for a 15-second headline, not for
// anything longer. Four is chosen to be useful without turning one Nextcloud
// into a thundering herd against the SaaS; the SaaS enforces its own limits.
const MAX_CONCURRENT_PER_PROVIDER = 4;
// Bounded so a task that immediately re-queues cannot spin forever.
const MAX_TASKS_PER_DRAIN = 50;

// Providers currently being drained. A trigger arriving mid-drain is a no-op:
// the running drain re-fetches until the queue is empty, so it will pick the
// new task up anyway, and starting a second pool would just double the
// concurrency we deliberately bounded.
const _draining = new Set();

/**
 * Drain every queued task for one provider, up to MAX_CONCURRENT at a time.
 *
 * Loops rather than handling one: Nextcloud only triggers when the queue goes
 * from empty to non-empty, so a burst of ten tasks produces a single call and
 * the other nine would sit until something else woke us.
 */
// The loop, with its two I/O calls injected. Kept separate from
// drainProvider so the concurrency, re-entrancy and budget behaviour can be
// tested without a Nextcloud to fetch from — the properties that matter here
// are about scheduling, not about HTTP.
async function _drainWith({ fetchNextTask: fetchNext, runTask: run }, id, { concurrency = MAX_CONCURRENT_PER_PROVIDER } = {}) {
    if (_draining.has(id)) return 0;
    _draining.add(id);
    try {
        let started = 0;
        let queueEmpty = false;

        const worker = async () => {
            while (!queueEmpty && started < MAX_TASKS_PER_DRAIN) {
                let task;
                try {
                    task = await fetchNext(id);
                } catch (err) {
                    console.warn(`[TaskProcessing] could not fetch next task for ${id}: ${err.message}`);
                    // Stop the whole pool: if Nextcloud is refusing us, the
                    // other workers will only produce the same error N times.
                    queueEmpty = true;
                    return;
                }
                if (!task) { queueEmpty = true; return; }
                started += 1;
                // run never throws — it reports failure to Nextcloud and
                // returns, so one bad task cannot take the pool down with it.
                await run(task);
            }
        };

        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
        return started;
    } finally {
        _draining.delete(id);
    }
}

async function drainProvider(id, opts) {
    return _drainWith({ fetchNextTask, runTask }, id, opts);
}

/**
 * Poll every provider on a slow tick.
 *
 * Nextcloud's `trigger()` is not a reliable wake-up: Manager.php suppresses it
 * whenever a task of that type is ALREADY running
 * (`if (!$this->taskMapper->hasRunningTasksForTaskType(...))`). So the second
 * concurrent user of a task type generates no trigger at all, and without a
 * poll their task waits for whatever happens to arrive next. `context_agent`
 * keeps an idle poll for exactly this reason.
 *
 * Backs off once idle so an instance nobody is using is not making a request
 * per provider every few seconds, and resets to the fast tick whenever a
 * trigger arrives or a task is found — the moment there is one task there is
 * usually another.
 */
const POLL_FAST_MS = 5_000;
const POLL_IDLE_MS = 300_000;
const POLL_BACKOFF_AFTER_EMPTY = 6;

let _pollTimer = null;
let _emptyRounds = 0;

async function pollOnce() {
    let found = 0;
    for (const t of TASK_TYPES) {
        try {
            found += await drainProvider(providerId(t.id));
        } catch (err) {
            console.warn(`[TaskProcessing] poll failed for ${t.id}: ${err.message}`);
        }
    }
    if (found > 0) _emptyRounds = 0; else _emptyRounds += 1;
    return found;
}

function currentPollDelay() {
    return _emptyRounds >= POLL_BACKOFF_AFTER_EMPTY ? POLL_IDLE_MS : POLL_FAST_MS;
}

function scheduleNextPoll() {
    if (_pollTimer) clearTimeout(_pollTimer);
    _pollTimer = setTimeout(() => {
        pollOnce()
            .catch(err => console.warn(`[TaskProcessing] poll error: ${err.message}`))
            .finally(scheduleNextPoll);
    }, currentPollDelay());
    // Never hold the process open for a poll.
    _pollTimer.unref?.();
}

function startPolling() {
    if (_pollTimer || !config.tenantKey) return;
    scheduleNextPoll();
}

function stopPolling() {
    if (_pollTimer) clearTimeout(_pollTimer);
    _pollTimer = null;
    _emptyRounds = 0;
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
        // A trigger means work exists, so come off the idle tick immediately —
        // the next few minutes are the likeliest time for more.
        _emptyRounds = 0;
        scheduleNextPoll();
        setImmediate(() => {
            drainProvider(id).catch(err =>
                console.warn(`[TaskProcessing] drain failed for ${id}: ${err.message}`));
        });
    });
    startPolling();
}

module.exports = {
    registerTaskProcessing,
    unregisterTaskProcessing,
    registerRoutes,
    drainProvider,
    _drainWith,
    providerId,
    providerDefinition,
    watchdogMsFor,
    startPolling,
    stopPolling,
    TASK_TYPES,
    USER_ERRORS,
    MAX_CONCURRENT_PER_PROVIDER,
    POLL_FAST_MS,
    POLL_IDLE_MS,
};
