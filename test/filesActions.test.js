/**
 * Bee Flow entries in the Files right-click menu.
 *
 * The reason this surface is worth having at all: it is the ONLY way into
 * Nextcloud's own UI that does not need a PHP app. AppAPI exposes no
 * `registerReferenceProvider`, no Dashboard widget registration and no sidebar
 * tab — but it does mount its Files plugin as soon as any ExApp registers a
 * file action, so one OCS call buys ambient presence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const fa = require('../src/filesActions');

test('every entry points at the handler route the connector actually serves', () => {
    // A mismatch here is a menu entry that 404s on click, and the user sees
    // nothing but a console error.
    const expected = fa.HANDLER_PATH.replace(/^\//, '');
    assert.ok(fa.ACTIONS.length > 0);
    for (const a of fa.ACTIONS) {
        assert.equal(a.actionHandler, expected, `${a.name} must post to the served route`);
        assert.ok(a.displayName && a.displayName.length > 3, `${a.name} needs a human label`);
        assert.ok(Number.isInteger(a.order), `${a.name} needs a stable order`);
    }
});

test('entry names are unique — AppAPI upserts by (appId, name)', () => {
    const names = fa.ACTIONS.map(a => a.name);
    assert.equal(new Set(names).size, names.length,
        'a duplicate name would silently overwrite the other entry on registration');
});

test('every entry asks only for READ', () => {
    // All three actions only read the file. Asking for more would hide the
    // entry on files the user can open but not modify — including anything
    // inside a read-only share, which is exactly where "ask about this" is
    // most useful.
    for (const a of fa.ACTIONS) {
        assert.equal(a.permissions, 1, `${a.name} should require READ only`);
    }
});

test('"Summarise" is scoped to text, not offered on every file', () => {
    // Nextcloud matches `mime` against the node, so a Summarise entry on a
    // .zip is a menu item that can only disappoint.
    const summarise = fa.ACTIONS.find(a => a.name === 'beeflow_summarise');
    assert.equal(summarise.mime, 'text');
});

test('the handler reads the v2 batch envelope, not a bare node', () => {
    // v1 posted one node; v2 posts {files: [...]} and sends the whole
    // multi-select in a single request. Reading the v1 shape would mean every
    // click looked empty.
    const files = fa.parseFiles({ files: [
        { fileId: 42, name: 'a.pdf', path: '/a.pdf', mime: 'application/pdf' },
        { fileid: 43, name: 'b.txt' },
        { id: 44 },
    ] });
    assert.deepEqual(files.map(f => f.fileId), [42, 43, 44]);
    assert.equal(files[0].name, 'a.pdf');
});

test('a malformed or empty payload yields no files rather than throwing', () => {
    // AppAPI's own frontend builds this payload, so its exact keys move across
    // Nextcloud versions. Throwing here fails the user's click invisibly.
    for (const body of [undefined, null, {}, { files: null }, { files: 'nope' }, { files: [{}, null] }]) {
        assert.deepEqual(fa.parseFiles(body), []);
    }
});
