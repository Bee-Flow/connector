// Install-time values: what info.xml offers in the deploy options, how the
// connector reads them, and where its texts send an administrator who wants to
// change one. AppAPI has a register command with --env and the deploy options
// at install; it has no command that changes a value of an installed app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';

const ROOT = path.join(__dirname, '..');
const { intFromEnv, wordFromEnv } = require('../src/envValues');

// Written in two halves so this file does not contain the string it looks for.
const ABSENT_COMMAND = ['app_api:app:', 'setenv'].join('');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['CHANGELOG.md']);

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...filesUnder(path.join(dir, entry.name)));
        } else if (entry.isFile() && !(dir === ROOT && SKIP_FILES.has(entry.name))) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

test('no file of the connector names a command AppAPI does not have', () => {
    const files = filesUnder(ROOT);
    assert.ok(files.length > 50, 'the walk found the connector sources');
    const hits = files.filter((file) => fs.readFileSync(file).includes(ABSENT_COMMAND))
        .map((file) => path.relative(ROOT, file));
    assert.deepEqual(hits, [], `${ABSENT_COMMAND} does not exist; name the setup page, the deploy options `
        + 'at install, or registering the app again with --env');
});

/** @returns {{ name: string, body: string }[]} */
function declaredVariables() {
    const xml = fs.readFileSync(path.join(ROOT, 'appinfo', 'info.xml'), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '');
    const block = xml.slice(xml.indexOf('<environment-variables>'), xml.indexOf('</environment-variables>'));
    return [...block.matchAll(/<variable>([\s\S]*?)<\/variable>/g)].map((m) => ({
        name: (m[1].match(/<name>([^<]*)<\/name>/) || [])[1],
        body: m[1],
    }));
}

test('the advanced settings are install-time options without a default element', () => {
    const variables = declaredVariables();
    for (const name of [
        'BEEFLOW_NC_PROXY_MAX_BODY_MB',
        'BEEFLOW_NC_PROXY_MAX_INFLIGHT_MB',
        'BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS',
        'LOG_LEVEL',
        'BEEFLOW_SIG_SKEW_SECONDS',
    ]) {
        const found = variables.filter((v) => v.name === name);
        assert.equal(found.length, 1, `${name} is declared once`);
        assert.doesNotMatch(found[0].body, /<default/, `${name} has no <default>: left blank, AppAPI exports nothing`);
        assert.match(found[0].body, /<display-name>[^<]+<\/display-name>/);
        assert.match(found[0].body, /<description>[^<]+<\/description>/);
    }
});

test('no variable has an empty default element', () => {
    // AppAPI on Nextcloud 33 and 34 exports an empty <default> as the text "Array".
    for (const v of declaredVariables()) {
        assert.doesNotMatch(v.body, /<default\s*\/>|<default>\s*<\/default>/, `${v.name}`);
    }
});

test('a number from the environment falls back when unusable and stays inside its range', () => {
    const range = { fallback: 300, min: 30, max: 900 };
    const read = (value) => intFromEnv('X', range, value === undefined ? {} : { X: value });
    assert.equal(read(undefined), 300);
    assert.equal(read(''), 300);
    assert.equal(read('   '), 300);
    assert.equal(read('Array'), 300);
    assert.equal(read('abc'), 300);
    assert.equal(read('12abc'), 300);
    assert.equal(read('NaN'), 300);
    assert.equal(read('Infinity'), 300);
    assert.equal(read('120'), 120);
    assert.equal(read(' 120 '), 120);
    assert.equal(read('120.9'), 120);
    assert.equal(read('1'), 30);
    assert.equal(read('-5'), 300, 'a negative number is not a value: the default applies');
    assert.equal(read('0'), 30);
    assert.equal(read('999999'), 900);

    // Where 0 means "off", a negative number does not switch anything off.
    const timeout = { fallback: 60_000, min: 0, max: 86_400_000 };
    assert.equal(intFromEnv('X', timeout, { X: '-1' }), 60_000);
    assert.equal(intFromEnv('X', timeout, { X: '-0.5' }), 60_000);
    assert.equal(intFromEnv('X', timeout, { X: '0' }), 0);
});

test('a word from the environment is one of the allowed words, else the fallback', () => {
    const levels = ['debug', 'info', 'warn', 'error'];
    const read = (value) => wordFromEnv('LOG_LEVEL', levels, 'info', value === undefined ? {} : { LOG_LEVEL: value });
    assert.equal(read(undefined), 'info');
    assert.equal(read(''), 'info');
    assert.equal(read('Array'), 'info');
    assert.equal(read('verbose'), 'info');
    assert.equal(read('debug'), 'debug');
    assert.equal(read(' WARN '), 'warn');
    assert.equal(read('error'), 'error');
});

/**
 * A module loaded anew under the given environment values.
 * @param {string} file @param {Record<string, string | undefined>} env @param {string[]} [alsoReload]
 */
function loadWith(file, env, alsoReload = []) {
    const before = {};
    for (const [k, v] of Object.entries(env)) {
        before[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const f of [file, ...alsoReload]) delete require.cache[require.resolve(f)];
    try {
        return require(file);
    } finally {
        for (const [k, v] of Object.entries(before)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        for (const f of [file, ...alsoReload]) delete require.cache[require.resolve(f)];
    }
}

test('the allowed clock difference is 300 unless a usable value is given, and stays between 30 and 900', () => {
    const skew = (value) => loadWith('../src/config', { BEEFLOW_SIG_SKEW_SECONDS: value }).sigSkewSeconds;
    assert.equal(skew(undefined), 300);
    assert.equal(skew(''), 300);
    assert.equal(skew('Array'), 300);
    assert.equal(skew('ten'), 300);
    assert.equal(skew('600'), 600);
    assert.equal(skew('5'), 30);
    assert.equal(skew('86400'), 900);
});

test('the token lifetime is a usable number whatever the environment holds', () => {
    const ttl = (value) => loadWith('../src/config', { BEEFLOW_JWT_TTL_SECONDS: value }).jwtTtlSeconds;
    assert.equal(ttl(undefined), 300);
    assert.equal(ttl('soon'), 300);
    assert.equal(ttl('120'), 120);
    assert.equal(ttl('1'), 30);
    assert.equal(ttl('86400'), 900);
});

test('the upload caps keep their default on an unusable value; 0 means no cap', () => {
    const cap = (value) => loadWith('../src/ncProxy', { BEEFLOW_NC_PROXY_MAX_BODY_MB: value }).MAX_BODY_BYTES;
    const MB = 1024 * 1024;
    assert.equal(cap(undefined), 100 * MB);
    assert.equal(cap(''), 100 * MB);
    assert.equal(cap('  '), 100 * MB);
    assert.equal(cap('Array'), 100 * MB);
    assert.equal(cap('-1'), 100 * MB);
    assert.equal(cap('250'), 250 * MB);
    assert.equal(cap('0'), Infinity);
});
