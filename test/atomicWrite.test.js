'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../src/atomicWrite');

test('a reader polling during repeated writes never sees an empty or unparseable file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-atomic-'));
    const file = path.join(dir, 'tenant-key.json');
    await writeFileAtomic(file, JSON.stringify({ n: 0, pad: 'x'.repeat(5000) }));
    let writing = true;
    let reads = 0;
    const bad = [];
    const reader = (async () => {
        while (writing) {
            try {
                JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (e) {
                bad.push(e.message);
            }
            reads++;
            await new Promise((r) => setImmediate(r));
        }
    })();
    for (let i = 1; i <= 200; i++) {
        await writeFileAtomic(file, JSON.stringify({ n: i, pad: 'x'.repeat(5000) }));
    }
    writing = false;
    await reader;
    assert.ok(reads > 0);
    assert.deepEqual(bad, []);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 200);
    assert.deepEqual(fs.readdirSync(dir), ['tenant-key.json'], 'no temp file is left behind');
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

test('a failed write leaves the target untouched and removes the temp file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-atomic-'));
    const file = path.join(dir, 'a.json');
    await writeFileAtomic(file, '{"ok":true}');
    fs.mkdirSync(path.join(dir, 'target-dir'));
    await assert.rejects(writeFileAtomic(path.join(dir, 'target-dir'), 'x'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'target-dir']);
});
