/**
 * `webhook_listeners` registration + delivery parsing.
 *
 * These guard the rewrite away from AppAPI's removed `events_listener` API.
 * The class that regressed before was silent: the old handler read
 * `req.body.eventType`, the envelope carried `event_type`, and every delivery
 * was dropped with a 200. So the assertions here are deliberately about the
 * exact key names and the exact envelope shape Nextcloud sends.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';

const config = require('../src/config');
const wl = require('../src/webhookListeners');
const hook = require('../src/automationEventsWebhook');

// Deck classes verified to implement IWebhookCompatibleEvent upstream
// (deck@HEAD lib/Event/ACardEvent.php:16). Its `Session*Event` and
// `ABoardImportGetAllowedEvent` do NOT, so Deck cannot be allowed wholesale.
// AAclEvent and BoardUpdatedEvent are compatible but intentionally unregistered
// — Bee Flow has no catalogue entry for board or ACL changes yet.
const DECK_WEBHOOK_COMPATIBLE = new Set([
    'OCA\\Deck\\Event\\CardCreatedEvent',
    'OCA\\Deck\\Event\\CardUpdatedEvent',
    'OCA\\Deck\\Event\\CardDeletedEvent',
]);

test('only webhook-compatible event classes are registered', () => {
    // WebhooksEventListener::serializeEvent() calls getWebhookSerializable()
    // unconditionally, so registering a class that does not implement
    // IWebhookCompatibleEvent fatals inside a Nextcloud background job — where
    // the admin never sees it. Verified upstream: Share, Talk, User and Group
    // events do NOT implement it. Keep them out.
    const forbidden = ['\\Share\\', '\\Talk\\', '\\User\\Events\\', '\\Group\\Events\\'];
    for (const entry of wl.EVENTS) {
        for (const frag of forbidden) {
            assert.ok(
                !entry.class.includes(frag),
                `${entry.class} is not an IWebhookCompatibleEvent — it cannot be webhooked`,
            );
        }
        // Deck is per-class rather than per-namespace: most of it is fine,
        // some of it fatals.
        if (entry.class.includes('\\Deck\\')) {
            assert.ok(
                DECK_WEBHOOK_COMPATIBLE.has(entry.class),
                `${entry.class} is not a verified-compatible Deck event — check it implements `
                + 'IWebhookCompatibleEvent before registering it',
            );
        }
    }
});

test('Deck card events are registered — the "Deck exposes nothing" era is over', () => {
    // This assertion exists because the opposite belief outlived the fact by
    // three months: ACardEvent has implemented IWebhookCompatibleEvent since
    // Deck v1.18.0 (2026-05-03), while our own comment still said Deck had no
    // webhookable events at all. Five catalogue events and two shipped
    // templates were dead the whole time.
    for (const cls of DECK_WEBHOOK_COMPATIBLE) {
        assert.ok(wl.EVENT_BY_CLASS[cls], `${cls} should be registered`);
    }
    assert.equal(wl.EVENT_BY_CLASS['OCA\\Deck\\Event\\CardCreatedEvent'], 'deck.card.created');
    assert.equal(wl.EVENT_BY_CLASS['OCA\\Deck\\Event\\CardUpdatedEvent'], 'deck.card.changed');
    assert.equal(wl.EVENT_BY_CLASS['OCA\\Deck\\Event\\CardDeletedEvent'], 'deck.card.deleted');
    // Deck ships as an optional app; a missing class must not fail the batch.
    for (const e of wl.EVENTS.filter(x => x.class.includes('\\Deck\\'))) {
        assert.equal(e.optional, true, `${e.class} must be optional — Deck may not be installed`);
    }
});

test('every registered class maps to exactly one Bee Flow event id', () => {
    for (const entry of wl.EVENTS) {
        assert.equal(wl.EVENT_BY_CLASS[entry.class], entry.event);
    }
    assert.equal(Object.keys(wl.EVENT_BY_CLASS).length, wl.EVENTS.length,
        'duplicate class in EVENTS — one would silently shadow the other');
});

test('the hook secret is derived from the tenant key, never equal to it', () => {
    config.tenantKey = null;
    assert.equal(wl.hookSecret(), null, 'no tenant key → no secret (fail closed)');

    config.tenantKey = 'tenant-key-abc';
    const secret = wl.hookSecret();
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.notEqual(secret, config.tenantKey,
        'the value stored in Nextcloud\'s DB must not be usable against /nc/*');
    assert.equal(secret, wl.hookSecret(), 'must be deterministic so re-registration is stable');

    config.tenantKey = 'tenant-key-rotated';
    assert.notEqual(wl.hookSecret(), secret, 'rotating the tenant key must rotate the hook secret');
    config.tenantKey = null;
});

test('the callback URI routes through AppAPI\'s ExApp proxy', () => {
    const uri = wl.hookUri();
    assert.ok(uri.startsWith(config.nextcloudUrl), 'must target the Nextcloud host, not the container');
    assert.ok(uri.endsWith(`/index.php/apps/app_api/proxy/${config.appId}/hooks/nextcloud`));
});

test('mapEvent reads event.class — the key the new envelope actually uses', () => {
    assert.equal(hook.mapEvent('OCP\\Files\\Events\\Node\\NodeCreatedEvent'), 'file.new');
    assert.equal(hook.mapEvent('OCA\\Forms\\Events\\FormSubmittedEvent'), 'forms.submitted');
    assert.equal(hook.mapEvent('OCA\\Tables\\Event\\RowAddedEvent'), 'tables.row.added');
    assert.equal(hook.mapEvent(undefined), null);
    assert.equal(hook.mapEvent('OCA\\Unknown\\Event'), null);
});

test('node paths are rewritten to the user-relative form the tools speak', () => {
    assert.deepEqual(
        hook.toUserRelativePath('/alice/files/Documents/Invoice.pdf'),
        { path: '/Documents/Invoice.pdf', owner: 'alice', relative: true },
    );
    assert.deepEqual(
        hook.toUserRelativePath('/alice/files'),
        { path: '/', owner: 'alice', relative: true },
    );
    // Outside a files root (trashbin, versions, appdata) — passed through and
    // flagged so the SaaS does not treat it as a user path.
    const trash = hook.toUserRelativePath('/alice/files_trashbin/files/x.txt');
    assert.equal(trash.relative, false);
    assert.equal(trash.path, '/alice/files_trashbin/files/x.txt');
});

test('single-node file payload matches the trigger catalog shape', () => {
    const payload = hook.normalisePayload('file.new', {
        event: {
            class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent',
            node: { id: 437, path: '/alice/files/Documents/Invoice-2026-001.pdf' },
        },
        user: { uid: 'alice', displayName: 'Alice' },
        time: 1700100000,
    });
    assert.equal(payload.id, 437);
    assert.equal(payload.path, '/Documents/Invoice-2026-001.pdf');
    assert.equal(payload.name, 'Invoice-2026-001.pdf');
    assert.equal(payload.extension, 'pdf');
    assert.equal(payload.actor, 'alice');
    assert.equal(payload.datetime, new Date(1700100000 * 1000).toISOString());
});

test('a deleted node with no id still produces a usable payload', () => {
    // Documented upstream: NodeDeletedEvent and NonExistingFile/Folder omit id.
    const payload = hook.normalisePayload('file.deleted', {
        event: {
            class: 'OCP\\Files\\Events\\Node\\NodeDeletedEvent',
            node: { path: '/alice/files/old.txt' },
        },
        user: { uid: 'alice', displayName: 'Alice' },
        time: 1700100500,
    });
    assert.equal(payload.id, null);
    assert.equal(payload.path, '/alice/files/old.txt'.replace('/alice/files', ''));
    assert.equal(payload.name, 'old.txt');
});

test('two-node events expose both sides', () => {
    const payload = hook.normalisePayload('file.renamed', {
        event: {
            class: 'OCP\\Files\\Events\\Node\\NodeRenamedEvent',
            source: { path: '/alice/files/previousname.txt' },
            target: { id: 599, path: '/alice/files/newname.txt' },
        },
        user: { uid: 'alice', displayName: 'Alice' },
        time: 1700100000,
    });
    assert.equal(payload.id, 599);
    assert.equal(payload.path, '/newname.txt');
    assert.equal(payload.oldPath, '/previousname.txt');
    assert.equal(payload.sourceId, null);
});

test('tag events expose both the list and a convenience first element', () => {
    const payload = hook.normalisePayload('file.tagged', {
        event: {
            class: 'OCP\\SystemTag\\TagAssignedEvent',
            objectType: 'files',
            objectIds: ['437', '438'],
            tagIds: [3, 17],
        },
        user: { uid: 'admin', displayName: 'Admin' },
        time: 1700100000,
    });
    assert.deepEqual(payload.objectIds, ['437', '438']);
    assert.deepEqual(payload.tagIds, [3, 17]);
    assert.equal(payload.fileId, '437');
    assert.equal(payload.tagId, 3);
});

test('forms submissions carry the ids a routine needs to fetch the answers', () => {
    const payload = hook.normalisePayload('forms.submitted', {
        event: {
            class: 'OCA\\Forms\\Events\\FormSubmittedEvent',
            form: { id: 51, hash: 'abc123def456', title: 'Employee Feedback', ownerId: 'alice' },
            submission: { id: 220, formId: 51, userId: 'bob', timestamp: 1700001234 },
        },
        user: { uid: 'bob', displayName: 'Bob' },
        time: 1700001234,
    });
    assert.equal(payload.formId, 51);
    assert.equal(payload.formHash, 'abc123def456');
    assert.equal(payload.submissionId, 220);
    assert.equal(payload.submittedBy, 'bob');
});

test('tables row events keep values and previousValues distinct', () => {
    const payload = hook.normalisePayload('tables.row.updated', {
        event: {
            class: 'OCA\\Tables\\Event\\RowUpdatedEvent',
            tableId: 34,
            rowId: 7,
            previousValues: { 2: 'draft' },
            values: { 0: 'Project X', 2: 'active' },
        },
        user: { uid: 'carol', displayName: 'Carol' },
        time: 1700054321,
    });
    assert.equal(payload.tableId, 34);
    assert.equal(payload.rowId, 7);
    assert.deepEqual(payload.values, { 0: 'Project X', 2: 'active' });
    assert.deepEqual(payload.previousValues, { 2: 'draft' });
});

test('calendar payloads expose the object identifiers, not invented VEVENT fields', () => {
    // The envelope carries object metadata only — there is no summary/start/end
    // in it. Emitting nulls is honest; inventing values would silently break
    // every downstream binding.
    const payload = hook.normalisePayload('calendar.event.created', {
        event: {
            class: 'OCP\\Calendar\\Events\\CalendarObjectCreatedEvent',
            calendarId: 9,
            calendarData: { id: 9, uri: 'work' },
            objectData: { id: 22, uri: 'event-20251111T100000Z.ics', component: 'VEVENT' },
        },
        user: { uid: 'david', displayName: 'David' },
        time: 1700100000,
    });
    assert.equal(payload.uid, 'event-20251111T100000Z');
    assert.equal(payload.objectUri, 'event-20251111T100000Z.ics');
    assert.equal(payload.calendarId, 9);
    assert.equal(payload.calendarUri, 'work');
    assert.equal(payload.summary, null);
    assert.equal(payload.startsAt, null);
});

test('an event with no user session does not crash the parser', () => {
    const payload = hook.normalisePayload('file.new', {
        event: { class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', node: { id: 1, path: '/x/files/a.txt' } },
        user: null,
        time: 1700100000,
    });
    assert.equal(payload.actor, null);
    assert.equal(payload.path, '/a.txt');
});

test('registration does not ask Nextcloud to mint ephemeral user tokens', () => {
    // Bee Flow already impersonates any Nextcloud user via AppAPI's shared
    // secret, so `tokenNeeded` would put a real user credential in a webhook
    // body for no capability we lack. If this ever becomes deliberate, it must
    // come with a consumer — the failure mode we are avoiding is minting
    // credentials that nothing reads.
    config.tenantKey = 'tenant-key-abc';
    const secret = wl.hookSecret();
    for (const entry of wl.EVENTS) {
        const body = wl.webhookBody(entry, secret);
        assert.ok(!('tokenNeeded' in body), `${entry.event} must not request tokenNeeded`);
        // The registration must still authenticate itself — removing the token
        // request must not have removed the shared secret with it.
        assert.equal(body.authMethod, 'header');
        assert.equal(body.authData['X-Beeflow-Hook-Secret'], secret);
    }
    config.tenantKey = null;
});

test('the delivery handler does not forward an authentication block', () => {
    // Belt and braces: a stale webhook row registered by an older connector
    // could still deliver one.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'automationEventsWebhook.js'), 'utf8');
    const body = src.slice(src.indexOf('const body = JSON.stringify'), src.indexOf('const ts = Math.floor'));
    assert.ok(!body.includes('authentication'), 'the forwarded body must not carry credentials');
});

// ── Deck card payloads and derived transitions ──────────────────────────────
//
// Deck fires ONE class for every card mutation and serialises only the current
// card (ACardEvent::getWebhookSerializable). `cardBefore` exists on the PHP
// object and never reaches the wire, so "moved" and "completed" have to be
// recovered from the last state the connector saw. The rule these tests pin is
// the one that matters operationally: a cache miss must produce a false
// NEGATIVE, never a false positive — a `completed` trigger that re-fires on
// every later edit of a finished card is a trigger people switch off.

const deckEnvelope = (card) => ({
    event: { class: 'OCA\\Deck\\Event\\CardUpdatedEvent', card },
    user: { uid: 'alice', displayName: 'Alice' },
    time: 1770000000,
});

test('deck card payload exposes the fields a routine filters on', () => {
    const payload = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 42, title: 'Ship it', description: 'desc', stackId: 7, boardId: 3,
        done: '2026-08-12T09:00:00+00:00', archived: false, duedate: '2026-08-20T00:00:00+00:00',
        labels: [{ title: 'urgent' }, { title: 'ops' }],
        assignedUsers: [{ participant: { uid: 'bob' } }],
    }));
    assert.equal(payload.cardId, 42);
    assert.equal(payload.title, 'Ship it');
    assert.equal(payload.stackId, 7);
    assert.equal(payload.boardId, 3);
    // `done` stays the timestamp rather than becoming a boolean: "when was it
    // finished" is more useful downstream, and it is still truthy.
    assert.equal(payload.done, '2026-08-12T09:00:00+00:00');
    assert.deepEqual(payload.labels, ['urgent', 'ops']);
    assert.deepEqual(payload.assignedUsers, ['bob']);
    assert.equal(payload.actor, 'alice');
});

test('a card seen for the first time yields no transition, only the change', () => {
    hook._resetCardState();
    const payload = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 1, stackId: 2, done: '2026-08-12T09:00:00+00:00',
    }));
    // Already done on first sight — but we cannot know it just transitioned.
    assert.deepEqual(hook.deckTransitions('deck.card.changed', payload), []);
});

test('completing a card fires deck.card.completed exactly once', () => {
    hook._resetCardState();
    const open = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 1, stackId: 2, done: null }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', open), []);

    const done = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 1, stackId: 2, done: '2026-08-12T09:00:00+00:00',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', done), ['deck.card.completed']);

    // Editing an already-done card must NOT re-fire it. This is the whole
    // reason the cache exists.
    const edited = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 1, stackId: 2, done: '2026-08-12T09:00:00+00:00', title: 'renamed',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', edited), []);
});

test('moving a card between stacks fires deck.card.moved', () => {
    hook._resetCardState();
    const a = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 9, stackId: 1, done: null }));
    hook.deckTransitions('deck.card.changed', a);
    const b = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 9, stackId: 5, done: null }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', b), ['deck.card.moved']);
});

test('one update can be both moved and completed', () => {
    hook._resetCardState();
    const a = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 3, stackId: 1, done: null }));
    hook.deckTransitions('deck.card.changed', a);
    const b = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 3, stackId: 9, done: '2026-08-12T10:00:00+00:00',
    }));
    assert.deepEqual(
        hook.deckTransitions('deck.card.changed', b).sort(),
        ['deck.card.completed', 'deck.card.moved'],
    );
});

test('creation seeds the cache so the next update is a real comparison', () => {
    hook._resetCardState();
    const created = hook.normalisePayload('deck.card.created', deckEnvelope({ id: 4, stackId: 1, done: null }));
    assert.deepEqual(hook.deckTransitions('deck.card.created', created), []);
    const done = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 4, stackId: 1, done: '2026-08-12T11:00:00+00:00',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', done), ['deck.card.completed']);
});

test('deletion forgets the card so a recycled id cannot fake a transition', () => {
    hook._resetCardState();
    const a = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 5, stackId: 1, done: null }));
    hook.deckTransitions('deck.card.changed', a);
    const del = hook.normalisePayload('deck.card.deleted', deckEnvelope({ id: 5, stackId: 1, done: null }));
    hook.deckTransitions('deck.card.deleted', del);
    const back = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 5, stackId: 1, done: '2026-08-12T12:00:00+00:00',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', back), []);
});

test('an unknown stack on either side is not reported as a move', () => {
    hook._resetCardState();
    const a = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 6, done: null }));
    hook.deckTransitions('deck.card.changed', a);
    const b = hook.normalisePayload('deck.card.changed', deckEnvelope({ id: 6, stackId: 4, done: null }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', b), []);
});

test('the card cache is bounded so a busy board cannot grow it without limit', () => {
    hook._resetCardState();
    for (let i = 0; i < 5200; i++) {
        const p = hook.normalisePayload('deck.card.created', deckEnvelope({ id: i, stackId: 1, done: null }));
        hook.deckTransitions('deck.card.created', p);
    }
    // Card 0 was evicted, so completing it now yields no transition rather
    // than a wrong one.
    const old = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 0, stackId: 1, done: '2026-08-12T13:00:00+00:00',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', old), []);
    // A recent card still works.
    const recent = hook.normalisePayload('deck.card.changed', deckEnvelope({
        id: 5199, stackId: 1, done: '2026-08-12T13:00:00+00:00',
    }));
    assert.deepEqual(hook.deckTransitions('deck.card.changed', recent), ['deck.card.completed']);
});
