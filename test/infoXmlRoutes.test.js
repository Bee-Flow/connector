/**
 * appinfo/info.xml route allow-list, checked against AppAPI's ACTUAL matcher.
 *
 * AppAPI decides — before the connector ever sees a request — whether a path is
 * allowed and at which access level. Its matcher changed: it now tests each
 * route regex against the path WITH a leading slash ("mirroring HaRP's
 * target_path semantics"), keeping a bare-path fallback that its own source
 * marks for removal:
 *
 *     $canonicalSubject = '/' . $exAppRoute;
 *     $pattern = '~^(?:' . str_replace('~', '\~', $route['url']) . ')~i';
 *     $matched = preg_match($pattern, $canonicalSubject) === 1;
 *     if (!$matched && preg_match($pattern, $exAppRoute) === 1) {
 *         // TODO(deprecation): remove this bare-path fallback …
 *         $matched = true;
 *     }
 *     if ($matched && str_contains(strtolower($route['verb']), strtolower($method))) {
 *         // First match by path+verb wins — no falling through to broader routes.
 *         return $this->passesExAppProxyRouteAccessLevelCheck($route['access_level']) ? $route : [];
 *     }
 *
 * Every route here was written bare-anchored (`^api/…`), which matches ONLY via
 * that deprecated fallback. Once it goes, every one of them stops matching and
 * the USER-level `^.*` catch-all absorbs the lot — quietly downgrading
 * /heartbeat, /init and /enabled, and breaking the PUBLIC HMAC-authenticated
 * /nc/* callbacks the Bee Flow server uses to reach Nextcloud.
 *
 * The `^/?` form matches both subjects, so these assertions run the matcher
 * twice: once with the fallback available, once with it removed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INFO_XML = path.join(__dirname, '..', 'appinfo', 'info.xml');
const ACCESS = { PUBLIC: 0, USER: 1, ADMIN: 2 };

function parseRoutes() {
    const xml = fs.readFileSync(INFO_XML, 'utf8');
    const block = xml.slice(xml.indexOf('<routes>'), xml.indexOf('</routes>'));
    const routes = [];
    // A <route> may carry optional children after <access_level> —
    // <bruteforce_protection> and <headers_to_exclude> are both part of
    // AppAPI's route schema. Match each element inside the route rather than
    // insisting on a fixed three-child shape, or adding one silently drops
    // the route from this allow-list check (and, worse, lets the following
    // route inherit the miss).
    const routeRe = /<route>([\s\S]*?)<\/route>/g;
    let m;
    while ((m = routeRe.exec(block)) !== null) {
        const body = m[1];
        const pick = (tag) => (body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1];
        const url = pick('url'); const verb = pick('verb'); const access = pick('access_level');
        if (url === undefined || verb === undefined || access === undefined) continue;
        routes.push({ url: url.trim(), verb: verb.trim(), access: ACCESS[access.trim()] });
    }
    return routes;
}

/**
 * Port of ExAppProxyController::passesExAppProxyRoutesChecks.
 * `legacyFallback: false` simulates the post-deprecation matcher.
 */
function resolveRoute(routes, reqPath, method, { legacyFallback = true } = {}) {
    const canonical = '/' + reqPath;
    for (const route of routes) {
        // PHP's `~…~i` with the pattern wrapped in `^(?:…)`; JS needs no delimiters.
        const pattern = new RegExp('^(?:' + route.url + ')', 'i');
        let matched = pattern.test(canonical);
        if (!matched && legacyFallback) matched = pattern.test(reqPath);
        if (matched && route.verb.toLowerCase().includes(method.toLowerCase())) {
            return route; // first match by path+verb wins
        }
    }
    return null;
}

const routes = parseRoutes();

test('info.xml declares routes at all', () => {
    assert.ok(routes.length > 5, `expected the full allow-list, parsed ${routes.length}`);
});

// Path → the access level AppAPI must resolve. These are the levels the
// connector's own security model depends on, not decoration.
const EXPECTED = [
    // The chat send — the request the whole product hangs on.
    ['ai/chat/direct/stream', 'POST', ACCESS.USER],
    ['agents/abc-123/chat/stream', 'POST', ACCESS.USER],
    // Lifecycle: AppAPI itself calls these. PUBLIC/ADMIN, never USER — there is
    // no logged-in user on a heartbeat, so a USER level fails the health check.
    ['heartbeat', 'GET', ACCESS.PUBLIC],
    ['init', 'POST', ACCESS.ADMIN],
    ['enabled', 'PUT', ACCESS.ADMIN],
    // SaaS → Nextcloud callbacks. PUBLIC because they carry no NC session; they
    // are authenticated by the HMAC in ncProxy.js. A USER downgrade 404s every
    // Nextcloud tool (Files, Mail, Calendar, Deck, Talk…).
    ['nc/ocs/v2.php/cloud/users/alice', 'GET', ACCESS.PUBLIC],
    ['nc/remote.php/dav/files/alice/x.txt', 'PROPFIND', ACCESS.PUBLIC],
    // Static shell.
    ['', 'GET', ACCESS.PUBLIC],
    ['index.html', 'GET', ACCESS.PUBLIC],
    ['assets/index-abc123.js', 'GET', ACCESS.PUBLIC],
    ['favicon.ico', 'GET', ACCESS.PUBLIC],
    ['img/app.svg', 'GET', ACCESS.PUBLIC],
    ['js/embed.js', 'GET', ACCESS.PUBLIC],
    // Admin-only connector actions must NOT be absorbed by the USER catch-all.
    ['setup', 'GET', ACCESS.ADMIN],
    ['setup/rotate-tenant-key', 'POST', ACCESS.ADMIN],
    ['setup/diagnostics', 'GET', ACCESS.ADMIN],
    ['webhook/nc-events', 'POST', ACCESS.ADMIN],
    // Nextcloud `webhook_listeners` deliveries. PUBLIC because the calling
    // background job has no user session; the X-Beeflow-Hook-Secret header is
    // what authenticates it. A USER/ADMIN level here silently kills every push
    // trigger — the exact failure mode this whole rewrite exists to fix.
    ['hooks/nextcloud', 'POST', ACCESS.PUBLIC],
    // Ordinary SPA traffic.
    ['api/health', 'GET', ACCESS.USER],
    ['auth/user', 'GET', ACCESS.USER],
];

for (const legacyFallback of [true, false]) {
    const label = legacyFallback
        ? 'with AppAPI\'s bare-path fallback'
        : 'WITHOUT the bare-path fallback (post-deprecation AppAPI)';

    test(`routes resolve to the right access level — ${label}`, () => {
        for (const [reqPath, method, expected] of EXPECTED) {
            const route = resolveRoute(routes, reqPath, method, { legacyFallback });
            assert.ok(route, `${method} /${reqPath} matched no route ${label}`);
            const names = Object.fromEntries(Object.entries(ACCESS).map(([k, v]) => [v, k]));
            assert.equal(
                route.access, expected,
                `${method} /${reqPath} → ${names[route.access]} via "${route.url}", expected ${names[expected]} (${label})`,
            );
        }
    });
}

test('the catch-all stays USER — an anonymous catch-all is what App Store review flags', () => {
    const catchAll = routes[routes.length - 1];
    assert.match(catchAll.url, /\.\*$/, 'the last route should be the catch-all');
    assert.equal(catchAll.access, ACCESS.USER);
});

test('every route URL matches both the canonical and the bare subject form', () => {
    for (const route of routes) {
        assert.ok(
            route.url.startsWith('^/?') || !route.url.startsWith('^'),
            `route "${route.url}" is anchored bare-path only; use the ^/? form so it survives `
            + 'AppAPI removing its deprecated fallback',
        );
    }
});

test('the chat POST verb list covers what the SPA actually sends', () => {
    const route = resolveRoute(routes, 'ai/chat/direct/stream', 'POST');
    assert.ok(route.verb.toUpperCase().includes('POST'));
});

// ── Manifest currency + route hardening ─────────────────────────────────────

test('the supported-version floor tracks Nextcloud maintenance, not history', () => {
    const xml = fs.readFileSync(INFO_XML, 'utf8');
    const dep = xml.match(/<nextcloud\s+min-version="(\d+)"\s+max-version="(\d+)"/);
    assert.ok(dep, '<nextcloud min-version/max-version> must be declared');
    const min = Number(dep[1]);
    assert.ok(min >= 32,
        `min-version ${min}: Nextcloud 31 reached end-of-life in February 2026 — `
        + 'claiming it promises support that cannot be honoured');
    assert.ok(Number(dep[2]) >= min);
});

test('the static-secret hooks route carries brute-force protection; the HMAC route does not', () => {
    const xml = fs.readFileSync(INFO_XML, 'utf8');
    const routeOf = (needle) => {
        const all = [...xml.matchAll(/<route>([\s\S]*?)<\/route>/g)].map(m => m[1]);
        return all.find(r => r.includes(needle));
    };
    const hooks = routeOf('hooks\\/');
    assert.ok(hooks, 'the hooks route must exist');
    assert.match(hooks, /<bruteforce_protection>\s*\[[^\]]*401/,
        'hooks/ is guarded by a STATIC header secret — the one connector credential worth guessing at, '
        + 'so Nextcloud should throttle repeated rejections');

    const nc = routeOf('nc\\/');
    assert.ok(nc, 'the nc route must exist');
    assert.ok(!/<bruteforce_protection>/.test(nc),
        'nc/ 401s come from our OWN server on clock skew; throttling (or, under HaRP, IP-banning) '
        + 'the Bee Flow egress address would take out file access and user sync tenant-wide');
});
