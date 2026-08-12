/**
 * Task Processing provider registration.
 *
 * The failure this guards against is subtle and expensive: registering a
 * provider for a task type the SaaS cannot actually serve. Nextcloud routes
 * ALL of Assistant, Mail summaries, Talk summaries, Text and Office through
 * this API, so a provider that errors takes those features down for the whole
 * instance — worse than never registering at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const tp = require('../src/taskProcessing');

// The SaaS half of this contract. Present in the monorepo, absent in the
// published `Bee-Flow/connector` repo, which ships only the ExApp — so this is
// resolved rather than assumed.
const SAAS_ROUTE = path.join(__dirname, '..', '..', 'server', 'routes', 'nextcloudTaskProcessing.js');
const HAS_SAAS_SOURCE = fs.existsSync(SAAS_ROUTE);

// Skipped, not deleted, and not silently passing: the check is only MEANINGFUL
// where both halves exist. Running it in the split repo would fail on a missing
// path rather than on real drift, and deleting it would lose the guard in the
// one place that can enforce it. The skip reason says which case you are in.
test('every registered task type has a handler on the SaaS side', {
    skip: HAS_SAAS_SOURCE ? false : 'SaaS source not in this repo — this contract is enforced in the Bee-Flow-AI monorepo',
}, () => {
    // The two lists live in different repos and drift silently; this is the
    // only thing that ties them together.
    const routeSrc = fs.readFileSync(SAAS_ROUTE, 'utf8');
    for (const t of tp.TASK_TYPES) {
        assert.ok(
            routeSrc.includes(`'${t.id}'`),
            `${t.id} is registered with Nextcloud but has no handler in `
            + 'server/routes/nextcloudTaskProcessing.js — Nextcloud would route real '
            + 'Assistant traffic to a provider that always fails',
        );
    }
});

test('task types we cannot serve are not registered', () => {
    const ids = tp.TASK_TYPES.map(t => t.id);
    for (const unsupported of ['core:audio2text', 'core:text2image', 'core:text2speech',
        'core:audio2text:subtitles', 'core:image2text:ocr']) {
        assert.ok(!ids.includes(unsupported),
            `${unsupported} has no SaaS implementation — registering it would break that feature`);
    }
});

test('provider ids are namespaced so they cannot collide with llm2 or integration_openai', () => {
    for (const t of tp.TASK_TYPES) {
        const id = tp.providerId(t.id);
        assert.ok(id.startsWith('bee_flow:'), `${id} must be namespaced`);
        assert.ok(id.endsWith(t.id));
    }
    assert.equal(new Set(tp.TASK_TYPES.map(t => tp.providerId(t.id))).size, tp.TASK_TYPES.length,
        'duplicate provider id — one registration would shadow another');
});

test('the provider definition carries every field AppAPI reads', () => {
    // AppAPI's anonymous provider shim indexes these directly; a missing key is
    // a PHP warning and a broken provider rather than a clean rejection.
    const def = tp.providerDefinition(tp.TASK_TYPES[0]);
    for (const key of ['id', 'name', 'task_type', 'expected_runtime',
        'optional_input_shape', 'optional_output_shape',
        'input_shape_defaults', 'optional_input_shape_defaults',
        'input_shape_enum_values', 'optional_input_shape_enum_values',
        'output_shape_enum_values', 'optional_output_shape_enum_values']) {
        assert.ok(key in def, `provider definition is missing "${key}"`);
    }
    assert.equal(typeof def.expected_runtime, 'number');
    assert.ok(Array.isArray(def.optional_input_shape));
});

test('registration is skipped until a tenant key exists', async () => {
    // Registering before bootstrap would advertise a provider that cannot
    // reach Bee Flow at all.
    const config = require('../src/config');
    const before = config.tenantKey;
    config.tenantKey = null;
    const res = await tp.registerTaskProcessing();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-tenant-key');
    assert.equal(res.registered, 0);
    config.tenantKey = before;
});

// ── WS-1: concurrency, watchdog and the idle poll ───────────────────────────
//
// Three defects these pin, all of which are invisible until an instance has
// more than one user:
//
//   · drainProvider ran one task at a time, so an organisation queued behind
//     whoever asked first.
//   · Nothing ever timed a task out. Nextcloud will not do it either — its
//     MAX_TASK_AGE_SECONDS is six months and a task we never report on stays
//     SCHEDULED, i.e. a spinner that hangs forever.
//   · The connector had no idle poll and depended entirely on trigger(), which
//     Manager.php suppresses whenever a task of that type is already running.
//     The second concurrent user therefore generated no wake-up at all.

test('the watchdog deadline is derived from the type, and clamped', () => {
    // A 15-second headline must not be held for the same five minutes as a
    // long summary — but nor may a mis-declared runtime produce an absurd one.
    const headline = tp.watchdogMsFor('core:text2text:headline');
    const summary = tp.watchdogMsFor('core:text2text:summary');
    assert.ok(headline < summary, 'a faster type gets a shorter deadline');
    for (const t of tp.TASK_TYPES) {
        const ms = tp.watchdogMsFor(t.id);
        assert.ok(ms >= 60_000, `${t.id} deadline must not be shorter than a minute`);
        assert.ok(ms <= 5 * 60 * 1000, `${t.id} deadline must not exceed five minutes`);
    }
    // An unknown type still gets a sane deadline rather than NaN or Infinity.
    const unknown = tp.watchdogMsFor('core:something:new');
    assert.ok(Number.isFinite(unknown) && unknown >= 60_000 && unknown <= 5 * 60 * 1000);
});

test('failure messages distinguish "wait and retry" from "something is broken"', () => {
    // One sentence used to cover every failure, which told the user nothing
    // about what to do next.
    assert.notStrictEqual(tp.USER_ERRORS.timeout, tp.USER_ERRORS.upstream);
    for (const [kind, msg] of Object.entries(tp.USER_ERRORS)) {
        assert.ok(msg.length > 20, `${kind} needs a real sentence`);
        // Nothing operational may reach an end user.
        assert.ok(!/http|:\/\/|\b\d{3}\b/.test(msg), `${kind} must not leak a URL or status code`);
    }
});

test('drainProvider runs tasks concurrently, not one behind the other', async () => {
    // Four tasks that each take a tick. Serially that is four sequential
    // awaits; the pool must overlap them.
    let inFlight = 0;
    let peak = 0;
    const queue = ['a', 'b', 'c', 'd'];
    const fetchNextTask = async () => (queue.length ? { id: queue.shift(), type: 'core:text2text' } : null);
    const runTask = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight -= 1;
    };
    const started = await tp._drainWith({ fetchNextTask, runTask }, 'p', { concurrency: 4 });
    assert.strictEqual(started, 4);
    assert.ok(peak > 1, `tasks ran serially (peak in-flight ${peak})`);
});

test('a second drain for the same provider is a no-op, not double concurrency', async () => {
    // A trigger arriving mid-drain must not start a second pool — the running
    // one re-fetches until the queue is empty and will pick the task up.
    let release;
    const gate = new Promise(r => { release = r; });
    let calls = 0;
    const fetchNextTask = async () => { calls += 1; return calls === 1 ? { id: 'x', type: 'core:text2text' } : null; };
    const runTask = () => gate;

    const first = tp._drainWith({ fetchNextTask, runTask }, 'same', { concurrency: 1 });
    await new Promise(r => setImmediate(r));
    const second = await tp._drainWith({ fetchNextTask, runTask }, 'same', { concurrency: 1 });
    assert.strictEqual(second, 0, 'the overlapping drain should have backed off');
    release();
    await first;
});

test('a fetch failure stops the pool instead of erroring N times over', async () => {
    let calls = 0;
    const fetchNextTask = async () => { calls += 1; throw new Error('nextcloud says no'); };
    const runTask = async () => { throw new Error('should never run'); };
    const started = await tp._drainWith({ fetchNextTask, runTask }, 'boom', { concurrency: 4 });
    assert.strictEqual(started, 0);
    assert.ok(calls <= 4, `each worker should give up after one failure, saw ${calls}`);
});

test('the drain is bounded so a self-requeueing task cannot spin forever', async () => {
    const fetchNextTask = async () => ({ id: 'loop', type: 'core:text2text' });
    const runTask = async () => {};
    const started = await tp._drainWith({ fetchNextTask, runTask }, 'inf', { concurrency: 2 });
    assert.ok(started <= 50, `drain must stop at the budget, ran ${started}`);
    assert.ok(started >= 50, 'and should actually reach it here');
});
