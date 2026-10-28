// A fetch stub for the connector's outbound calls: the Nextcloud OCS endpoints
// bootstrap and the registrations use, plus any number of fake Bee Flow
// servers. Every call is recorded, so a test can assert what was sent where.
//
//   const world = installFakeWorld({ servers: { 'http://a.test': { 'POST /auth/connector/bootstrap': () => ({ tenantKey: 'k' }) } } });
//   ...
//   world.restore();
//
// A server handler gets (init, path) and returns a Response or a JSON body.
// Unmatched Nextcloud calls answer an OCS success with an empty list, which is
// what the registrations (task providers, file actions, webhooks) expect.

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ocs(data, status = 200) {
    return json({ ocs: { meta: { status: 'ok', statuscode: 200 }, data } }, status);
}

/**
 * @param {{ servers?: Record<string, Record<string, (init: RequestInit, path: string) => unknown>>,
 *           nc?: (method: string, url: string, init: RequestInit) => Response | undefined | Promise<Response | undefined> }} [opts]
 */
function installFakeWorld({ servers = {}, nc } = {}) {
    const real = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const method = (init.method || 'GET').toUpperCase();
        calls.push({ method, url, body: init.body ? String(init.body) : null, headers: init.headers || {} });
        for (const [base, handlers] of Object.entries(servers)) {
            if (!url.startsWith(`${base}/`)) continue;
            const p = url.slice(base.length).split('?')[0];
            const handler = handlers[`${method} ${p}`] || handlers[p];
            if (!handler) return json({ error: 'not found' }, 404);
            const out = await handler(init, p);
            return out instanceof Response ? out : json(out);
        }
        if (nc) {
            const out = await nc(method, url, init);
            if (out) return out;
        }
        if (url.includes('/cloud/capabilities')) {
            return ocs({ version: { string: '31.0.0' }, capabilities: { theming: { name: 'NC', instanceid: 'inst-1' } } });
        }
        if (url.includes('/cloud/groups/admin/users')) return ocs({ users: ['admin'] });
        if (url.includes('/cloud/users/admin')) {
            return ocs({ id: 'admin', email: 'admin@nc.test', displayname: 'Admin', groups: ['admin'] });
        }
        return ocs([]);
    };
    return {
        calls,
        /** @param {(c: { method: string, url: string }) => boolean} pred */
        count: (pred) => calls.filter(pred).length,
        restore: () => { globalThis.fetch = real; },
    };
}

module.exports = { installFakeWorld, json, ocs };
