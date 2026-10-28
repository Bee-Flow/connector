// #407: calendar triggers stayed with the person who caused the event,
// because the Bee Flow server could not tell whether a colleague can see the
// calendar. The connector now forwards the calendar's owner and its shares
// (principal and access only, from an allow-list), and for file events
// whether the node is a file or a folder, so the server stops guessing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';

const config = require('../src/config');
const hook = require('../src/automationEventsWebhook');
const { HOOK_PATH } = require('../src/webhookListeners');

const share = (principal, extra = {}) => ({
    href: `principal:${principal}`,
    commonName: 'Display Name That Must Stay Behind',
    status: 1,
    readOnly: false,
    '{http://owncloud.org/ns}principal': principal,
    '{http://owncloud.org/ns}group-share': principal.startsWith('principals/groups'),
    ...extra,
});

test('a calendar event names its calendar\'s owner and shares, and nothing else about them', () => {
    const payload = hook.normalisePayload('calendar.event.created', {
        user: { uid: 'bob', displayName: 'Bob' },
        event: {
            class: 'OCP\\Calendar\\Events\\CalendarObjectCreatedEvent',
            calendarId: 9,
            calendarData: { id: 9, uri: 'team', principaluri: 'principals/users/alice', '{DAV:}displayname': 'Team' },
            shares: [
                share('principals/users/bob', { readOnly: true }),
                share('principals/groups/sales'),
                share('principals/remote-users/x'), // not something the server can check
                { href: 'mailto:someone@example.com' },
                null,
            ],
            objectData: { uri: 'e1.ics', component: 'vevent' },
        },
    });
    assert.equal(payload.calendarOwner, 'alice');
    assert.deepEqual(payload.calendarShares, [
        { principal: 'principals/users/bob', readOnly: true },
        { principal: 'principals/groups/sales', readOnly: false },
    ]);
    assert.ok(!JSON.stringify(payload).includes('Display Name'), 'no display names leave Nextcloud');
});

test('a moved event is checked against the calendar it moved INTO', () => {
    const payload = hook.normalisePayload('calendar.event.moved', {
        event: {
            sourceCalendarId: 1, sourceCalendarData: { id: 1, uri: 'old', principaluri: 'principals/users/bob' },
            sourceShares: [share('principals/users/eve')],
            targetCalendarId: 2, targetCalendarData: { id: 2, uri: 'team', principaluri: 'principals/users/alice' },
            targetShares: [share('principals/users/carol')],
            objectData: { uri: 'e1.ics' },
        },
    });
    assert.equal(payload.calendarUri, 'team');
    assert.equal(payload.calendarOwner, 'alice');
    assert.deepEqual(payload.calendarShares, [{ principal: 'principals/users/carol', readOnly: false }]);
});

test('a calendar of a room, a resource or the system has no owner to check', () => {
    assert.equal(hook.calendarOwnerOf('principals/calendar-rooms/r1'), null);
    assert.equal(hook.calendarOwnerOf('principals/system/system'), null);
    assert.equal(hook.calendarOwnerOf(undefined), null);
    assert.equal(hook.calendarOwnerOf('principals/users/alice/extra'), null);
});

/** Run one webhook delivery; returns what was forwarded to Bee Flow. */
async function deliver(t, envelope, ncAnswer) {
    const forwarded = [];
    const realFetch = globalThis.fetch;
    const props = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith(config.apiBaseUrl)) {
            forwarded.push(JSON.parse(String(init.body)));
            return new Response('{}', { status: 200 });
        }
        if (init.method === 'PROPFIND') {
            props.push({ url: u, auth: Buffer.from(init.headers['AUTHORIZATION-APP-API'], 'base64').toString().split(':')[0] });
            return ncAnswer();
        }
        return realFetch(url, init);
    };
    t.after(() => { globalThis.fetch = realFetch; });
    config.ncInstanceId = 'inst-1';
    const app = express();
    app.use('/', hook);
    const server = app.listen(0);
    t.after(() => server.close());
    const secret = crypto.createHmac('sha256', config.tenantKey).update('beeflow:webhook-listener:v1').digest('hex');
    const res = await realFetch(`http://127.0.0.1:${server.address().port}${HOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beeflow-hook-secret': secret },
        body: JSON.stringify(envelope),
    });
    assert.equal(res.status, 200);
    return { forwarded, props };
}

const created = (path) => ({
    user: { uid: 'bob' },
    event: { class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', node: { id: 437, path } },
});
const davAnswer = (resourcetype) => () => new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:resourcetype>${resourcetype}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { status: 207 });

test('a new folder is forwarded as a folder, asked of Nextcloud as its owner', async (t) => {
    const { forwarded, props } = await deliver(t, created('/alice/files/Projects/2026'), davAnswer('<d:collection/>'));
    assert.equal(forwarded[0].payload.nodeType, 'folder');
    assert.deepEqual(props, [{ url: 'http://nc.test/remote.php/dav/files/alice/Projects/2026', auth: 'alice' }]);
});

test('a new file is forwarded as a file, even without an extension', async (t) => {
    const { forwarded } = await deliver(t, created('/alice/files/Projects/README'), davAnswer(''));
    assert.equal(forwarded[0].payload.nodeType, 'file');
});

test('when Nextcloud does not say, nodeType is null and the event still goes through', async (t) => {
    const { forwarded } = await deliver(t, created('/alice/files/x.pdf'), () => new Response('', { status: 404 }));
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].payload.nodeType, null);
});
