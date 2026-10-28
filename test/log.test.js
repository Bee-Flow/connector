const test = require('node:test');
const assert = require('node:assert');

const log = require('../src/log');
const { createLogger, isJsonMode } = log;

function sink() {
    const lines = [];
    return { lines, stream: { write: (s) => lines.push(s) } };
}
const fixedNow = () => new Date('2026-01-02T03:04:05.000Z');

test('JSON mode writes one parseable line per event', () => {
    const { lines, stream } = sink();
    const l = createLogger({ json: true, stream, now: fixedNow });
    l.warn('[Talk] bot %s failed', 'x');
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].endsWith('\n') && lines[0].indexOf('\n') === lines[0].length - 1, 'exactly one line');
    assert.deepStrictEqual(JSON.parse(lines[0]), { ts: '2026-01-02T03:04:05.000Z', level: 'warn', msg: '[Talk] bot x failed' });
});

test('an Error argument is carried as err, and its message is in msg', () => {
    const { lines, stream } = sink();
    const l = createLogger({ json: true, stream, now: fixedNow });
    const e = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    l.error('[Setup] failed:', e);
    const out = JSON.parse(lines[0]);
    assert.strictEqual(out.msg, '[Setup] failed: boom');
    assert.deepStrictEqual(out.err, { name: 'Error', message: 'boom', code: 'E_BOOM' });
    assert.ok(!('stack' in out.err), 'no stack trace in the log line');
});

test('LOG_LEVEL filters in JSON mode', () => {
    const { lines, stream } = sink();
    const l = createLogger({ json: true, level: 'warn', stream, now: fixedNow });
    l.debug('d'); l.info('i'); l.log('i2'); l.warn('w'); l.error('e');
    assert.deepStrictEqual(lines.map((s) => JSON.parse(s).level), ['warn', 'error']);
});

test('console mode calls the console method at call time (spies keep working)', () => {
    const l = createLogger({ json: false });
    const seen = [];
    const real = { warn: console.warn, log: console.log };
    console.warn = (...a) => seen.push(['warn', ...a]);
    console.log = (...a) => seen.push(['log', ...a]);
    try { l.warn('a', 1); l.info('b'); } finally { Object.assign(console, real); }
    assert.deepStrictEqual(seen, [['warn', 'a', 1], ['log', 'b']]);
});

test('isJsonMode: LOG_FORMAT wins, else production', () => {
    assert.strictEqual(isJsonMode({ NODE_ENV: 'production' }), true);
    assert.strictEqual(isJsonMode({ NODE_ENV: 'test' }), false);
    assert.strictEqual(isJsonMode({ NODE_ENV: 'production', LOG_FORMAT: 'console' }), false);
    assert.strictEqual(isJsonMode({ LOG_FORMAT: 'json' }), true);
});

test('ref() gives a stable short digest and never the id itself', () => {
    assert.strictEqual(log.ref('alice'), log.ref('alice'));
    assert.notStrictEqual(log.ref('alice'), log.ref('bob'));
    assert.match(log.ref('alice'), /^u_[0-9a-f]{8}$/);
    assert.ok(!log.ref('alice').includes('alice'));
    assert.strictEqual(log.ref(undefined), '-');
});
