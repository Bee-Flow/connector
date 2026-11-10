// A request to the setup routes as an administrator, the way server.js mounts
// them, and a wait for something those routes start in the background.
//
// Required before a test replaces globalThis.fetch: the request itself goes
// over the real network stack.

const express = require('express');

const realFetch = globalThis.fetch;

/**
 * POST to a path under the setup router as the Nextcloud administrator. With a
 * body it is sent as JSON; without one the request has no body and no headers
 * of its own.
 * @param {import('express').Router} setupRouter
 * @param {string} pathname  for example `/setup` or `/setup/rotate-tenant-key`
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postAsAdmin(setupRouter, pathname, body) {
    const app = express();
    app.use((req, _res, next) => { req.beeflow = { user: { uid: 'admin', isNcAdmin: true } }; next(); });
    app.use('/setup', setupRouter);
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const init = body === undefined
            ? { method: 'POST' }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        const res = await realFetch(`http://127.0.0.1:${port}${pathname}`, init);
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

/** @param {() => boolean} cond */
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
        await new Promise((r) => setTimeout(r, 10));
    }
}

module.exports = { postAsAdmin, until };
