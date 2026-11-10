/**
 * Reporting a task's result back to Nextcloud.
 *
 * Nextcloud never times a task out (see the watchdog note in taskProcessing.js):
 * a task whose result does not land stays RUNNING and the user watches a
 * spinner. `POST /taskprocessing/tasks_provider/{id}/result` answers 404 when
 * the task is gone and 500 when storing the result failed
 * (core/Controller/TaskProcessingApiController.php, setResult), and fetch()
 * resolves for both. The report used to look only at network errors, so a 500
 * was dropped without a log line and without a second attempt.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';

const tp = require('../src/taskProcessing');
const log = require('../src/log');

/**
 * Run `fn` with fetch answering from `answers` (a status, or an Error to throw)
 * and with warnings captured.
 */
async function withNextcloud(answers, fn) {
    const realFetch = global.fetch;
    const realWarn = log.warn;
    const calls = [];
    const warnings = [];
    let i = 0;
    global.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        const answer = answers[Math.min(i, answers.length - 1)];
        i += 1;
        if (answer instanceof Error) throw answer;
        return { ok: answer >= 200 && answer < 300, status: answer, text: async () => '' };
    };
    log.warn = (msg) => { warnings.push(String(msg)); };
    try {
        return await fn({ calls, warnings });
    } finally {
        global.fetch = realFetch;
        log.warn = realWarn;
    }
}

const NO_WAIT = { retryDelaysMs: [0, 0] };

test('a result Nextcloud accepts is reported once', async () => {
    await withNextcloud([200], async ({ calls, warnings }) => {
        const ok = await tp._reportResult(7, { output: { output: 'hi' } }, NO_WAIT);
        assert.equal(ok, true);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/ocs\/v2\.php\/taskprocessing\/tasks_provider\/7\/result$/);
        assert.deepEqual(JSON.parse(calls[0].opts.body), { output: { output: 'hi' } });
        assert.deepEqual(warnings, []);
    });
});

test('a 500 from Nextcloud is retried, not dropped', async () => {
    await withNextcloud([500, 200], async ({ calls }) => {
        const ok = await tp._reportResult(7, { output: { output: 'hi' } }, NO_WAIT);
        assert.equal(ok, true, 'the second attempt landed, so the task is no longer stuck');
        assert.equal(calls.length, 2);
    });
});

test('a result that never lands is logged with the status, and the attempts are bounded', async () => {
    await withNextcloud([500], async ({ calls, warnings }) => {
        const ok = await tp._reportResult(7, { output: { output: 'hi' } }, NO_WAIT);
        assert.equal(ok, false);
        assert.equal(calls.length, 3);
        assert.equal(warnings.length, 1, 'one line for the task, not one per attempt');
        assert.match(warnings[0], /task 7/);
        assert.match(warnings[0], /HTTP 500/);
    });
});

test('a 404 means the task is gone: logged, and not retried', async () => {
    await withNextcloud([404], async ({ calls, warnings }) => {
        const ok = await tp._reportResult(7, { errorMessage: 'boom' }, NO_WAIT);
        assert.equal(ok, false);
        assert.equal(calls.length, 1);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /HTTP 404/);
    });
});

test('a network error is retried like a 500', async () => {
    await withNextcloud([new Error('ECONNRESET'), 200], async ({ calls, warnings }) => {
        const ok = await tp._reportResult(7, { output: { output: 'hi' } }, NO_WAIT);
        assert.equal(ok, true);
        assert.equal(calls.length, 2);
        assert.deepEqual(warnings, []);
    });
});
