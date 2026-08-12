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
