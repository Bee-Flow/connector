/**
 * Studio-app top-menu publication.
 *
 * Bee Flow's App Studio lets an owner publish an app "to the Nextcloud app
 * menu". This module is the Nextcloud half of that feature: it polls the SaaS
 * for the org's opted-in published apps and reconciles that list against
 * AppAPI's `ui/top-menu` registrations, so each app gets its own icon in the
 * Nextcloud top bar and opens on its own embedded page
 * (`/apps/app_api/embedded/<appId>/sa_<id>`).
 *
 * Flow per entry:
 *   1. POST /ocs/v1.php/apps/app_api/api/v1/ui/top-menu    {name:'sa_<hex>', displayName, icon}
 *   2. POST /ocs/v1.php/apps/app_api/api/v1/ui/script      {type:'top_menu', name:'sa_<hex>', path:'js/embed-app'}
 *   3. NC injects js/embed-app.js into the entry's embedded page; the script
 *      derives the app id from the page URL (the menu name IS the app id with
 *      dashes stripped — crypto.randomUUID() on the server) and mounts an
 *      iframe at the signed proxy with `?ncStudioApp=<appId>`, which the SPA
 *      resolves to its standalone app-run view.
 *   4. GET /img/studio-app/<name>.svg serves the entry's monochrome menu icon.
 *
 * Reconciliation is state-based: the registered set is persisted in
 * APP_PERSISTENT_STORAGE (studio-app-menus.json) so entries removed while the
 * container was down are still unregistered on the next sync. A failed or
 * unauthorized list fetch never unregisters anything — flapping the org's menu
 * on a SaaS hiccup would be worse than a stale entry.
 *
 * Auth to the SaaS is the tenant-key HMAC every other connector→SaaS
 * machine-to-machine call uses (see taskProcessing.js executeViaSaaS and
 * server/auth/connectorSig.js on the SaaS side): the signature covers
 * `${ts}\nGET\n${path}\n` with an empty body.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const STATE_FILE = 'studio-app-menus.json';
const LIST_PATH = '/api/nextcloud/studio-apps';
// Poll cadence. Each tick is one HTTPS GET to the SaaS and, when nothing
// changed, zero OCS calls — cheap enough to keep publish→visible latency low.
const SYNC_INTERVAL_MS = (parseInt(process.env.BEEFLOW_STUDIO_MENU_SYNC_SECONDS, 10) || 120) * 1000;
// NC's oc_ex_ui_top_menu display name column is bounded; keep names short.
const MAX_DISPLAY_NAME = 60;

// ── Menu-name mapping ───────────────────────────────────────────────
// App ids are crypto.randomUUID() (8-4-4-4-12 lowercase hex). The menu entry
// name embeds the id with dashes stripped, so the embed script can reconstruct
// the id from the page URL alone — no per-entry state has to reach the browser.

function menuNameForAppId(appId) {
    const hex = String(appId || '').toLowerCase().replace(/-/g, '');
    return /^[0-9a-f]{32}$/.test(hex) ? `sa_${hex}` : null;
}

function appIdForMenuName(name) {
    const m = /^sa_([0-9a-f]{32})$/.exec(String(name || ''));
    if (!m) return null;
    const h = m[1];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Persisted registration state ────────────────────────────────────

function statePath() {
    return path.join(config.persistentStorage, STATE_FILE);
}

function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        return (raw && typeof raw.entries === 'object' && raw.entries !== null) ? raw : { entries: {} };
    } catch (_) {
        return { entries: {} };
    }
}

function saveState(state) {
    try {
        fs.mkdirSync(config.persistentStorage, { recursive: true });
        fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (err) {
        console.warn(`[StudioAppMenus] Could not persist state: ${err.message}`);
    }
}

// ── SaaS: fetch the desired list ────────────────────────────────────

async function fetchDesiredApps() {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.tenantKey)
        .update(`${ts}\nGET\n${LIST_PATH}\n`).digest('hex');
    const res = await fetch(`${config.apiBaseUrl}${LIST_PATH}`, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'X-Beeflow-Source': 'nextcloud-connector',
            'X-Beeflow-NC-Instance-Id': config.ncInstanceId,
            'X-Beeflow-Sig': `${ts}.${sig}`,
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
        // Older Bee Flow server without the endpoint — feature simply off.
        return null;
    }
    if (!res.ok) {
        throw new Error(`SaaS answered HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.apps)) throw new Error('SaaS answered without an apps list');
    return data.apps;
}

// ── AppAPI OCS registration calls ───────────────────────────────────
// Service-level auth (empty uid), 409 = already registered = success — the
// same contract heartbeat.js uses for the main entry.

function appApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
    };
}

async function ocsCall(method, url, body, label) {
    const res = await withWarmupRetry(() => fetch(url, {
        method,
        headers: appApiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    }), { label, budgetMs: 30_000 });
    // 409 (already registered) and 404 (already gone on delete) are both the
    // desired end state.
    if (!res.ok && res.status !== 409 && !(method === 'DELETE' && res.status === 404)) {
        const text = await res.text().catch(() => '');
        throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
}

async function registerEntry(name, displayName) {
    const base = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui`;
    await ocsCall('POST', `${base}/top-menu`, {
        name,
        displayName: String(displayName || 'App').slice(0, MAX_DISPLAY_NAME),
        icon: `img/studio-app/${name}.svg`,
        adminRequired: 0,
    }, `top-menu:${name}`);
    await ocsCall('POST', `${base}/script`, {
        type: 'top_menu',
        name,
        path: 'js/embed-app',
        afterAppId: '',
    }, `embed-app-script:${name}`);
}

async function unregisterEntry(name) {
    const base = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui`;
    // Script first: a menu entry without its script is a blank page, but a
    // script without its entry is unreachable — remove in the safe order.
    await ocsCall('DELETE', `${base}/script`, {
        type: 'top_menu',
        name,
        path: 'js/embed-app',
    }, `embed-app-script-del:${name}`);
    await ocsCall('DELETE', `${base}/top-menu`, { name }, `top-menu-del:${name}`);
}

// ── Reconcile ───────────────────────────────────────────────────────

let _syncing = false;

/**
 * One reconcile pass: desired (SaaS) vs registered (persisted state).
 * Silently a no-op until bootstrap has produced a tenant key + instance id.
 * Returns { ok, added, removed, updated, skipped? } for logging/tests.
 */
async function syncStudioAppMenus() {
    if (!config.tenantKey || !config.ncInstanceId) return { ok: true, skipped: 'not_bootstrapped' };
    if (_syncing) return { ok: true, skipped: 'in_flight' };
    _syncing = true;
    try {
        let apps;
        try {
            apps = await fetchDesiredApps();
        } catch (err) {
            console.warn(`[StudioAppMenus] Could not fetch app list (keeping current menu): ${err.message}`);
            return { ok: false, error: err.message };
        }
        if (apps === null) return { ok: true, skipped: 'server_without_endpoint' };

        const desired = new Map();
        for (const app of apps) {
            const name = menuNameForAppId(app && app.id);
            if (!name) continue; // non-UUID id — cannot round-trip through the menu name
            desired.set(name, {
                appId: app.id,
                displayName: (typeof app.name === 'string' && app.name.trim()) ? app.name.trim() : 'App',
                icon: typeof app.icon === 'string' ? app.icon : null,
            });
        }

        const state = loadState();
        const registered = state.entries || {};
        let added = 0, removed = 0, updated = 0;

        // Register new entries; refresh renamed ones (AppAPI's POST answers 409
        // without updating, so a rename is delete + re-register).
        for (const [name, entry] of desired) {
            const known = registered[name];
            try {
                if (!known) {
                    await registerEntry(name, entry.displayName);
                    registered[name] = entry;
                    added++;
                } else if (known.displayName !== entry.displayName) {
                    await unregisterEntry(name);
                    await registerEntry(name, entry.displayName);
                    registered[name] = entry;
                    updated++;
                } else if (known.icon !== entry.icon) {
                    // Icon glyph is served live from state — no OCS call needed.
                    registered[name] = entry;
                    updated++;
                }
            } catch (err) {
                console.warn(`[StudioAppMenus] Register ${name} failed: ${err.message}`);
            }
        }

        // Unregister entries the SaaS no longer lists (unpublished, opted out,
        // or deleted).
        for (const name of Object.keys(registered)) {
            if (desired.has(name)) continue;
            try {
                await unregisterEntry(name);
                delete registered[name];
                removed++;
            } catch (err) {
                console.warn(`[StudioAppMenus] Unregister ${name} failed: ${err.message}`);
            }
        }

        state.entries = registered;
        saveState(state);
        if (added || removed || updated) {
            console.log(`[StudioAppMenus] Synced: +${added} -${removed} ~${updated} (now ${Object.keys(registered).length})`);
        }
        return { ok: true, added, removed, updated };
    } finally {
        _syncing = false;
    }
}

let _pollTimer = null;

function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => {
        syncStudioAppMenus().catch(err => console.warn(`[StudioAppMenus] Sync failed: ${err.message}`));
    }, SYNC_INTERVAL_MS);
    // A background convenience must never keep the process alive on its own.
    if (typeof _pollTimer.unref === 'function') _pollTimer.unref();
}

// ── Served assets ───────────────────────────────────────────────────

/**
 * The JS Nextcloud injects into a studio-app embedded page. Static on purpose:
 * the app id is derived from the page URL, so the script leaks nothing and
 * needs no per-request state. The iframe sizing mirrors js/embed (measured
 * offset, re-fit on resize/orientation/chrome settle) — see server.js for the
 * long-form rationale.
 */
function buildEmbedAppScript() {
    return `
(function() {
    var content = document.getElementById('content');
    if (!content) return;
    var m = (window.location.pathname || '').match(/\\/embedded\\/[^/]+\\/([A-Za-z0-9_.-]+)/);
    var hex = m ? /^sa_([0-9a-f]{32})$/.exec(m[1]) : null;
    if (!hex) {
        content.textContent = 'This Bee Flow app could not be loaded (invalid app link).';
        return;
    }
    var h = hex[1];
    var appId = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    content.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = OC.generateUrl('/apps/app_api/proxy/${config.appId}/') + '?ncStudioApp=' + appId;
    iframe.style.cssText = 'width:100%;border:0;display:block;';
    iframe.allow = 'clipboard-read; clipboard-write';
    content.appendChild(iframe);

    function fit() {
        var top = iframe.getBoundingClientRect().top;
        var h2 = Math.max(320, Math.round(window.innerHeight - top));
        iframe.style.height = h2 + 'px';
    }
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    if (typeof ResizeObserver === 'function') {
        try { new ResizeObserver(fit).observe(content); } catch (e) { /* older browsers */ }
    }
    setTimeout(fit, 0);
    setTimeout(fit, 250);
})();
`;
}

/**
 * Monochrome top-bar icon for one entry: the app's first letter in a rounded
 * tile. Nextcloud recolors menu icons via CSS filters, so the glyph must be a
 * plain dark shape on transparent — never the app's accent color. The letter
 * comes from the connector's own persisted state (display names never leave
 * the org's Nextcloud), with a neutral fallback when state is missing.
 */
function buildEntryIconSvg(displayName) {
    const match = String(displayName || '').trim().match(/[\p{L}\p{N}]/u);
    const letter = (match ? match[0] : '•').toUpperCase()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
        + '<rect x="2.25" y="2.25" width="19.5" height="19.5" rx="5" fill="none" stroke="#000000" stroke-width="1.7"/>'
        + `<text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" `
        + 'font-family="-apple-system, \'Segoe UI\', Roboto, sans-serif" font-size="11.5" font-weight="600" '
        + `fill="#000000">${letter}</text>`
        + '</svg>';
}

function registerRoutes(app) {
    app.get(['/js/embed-app', '/js/embed-app.js'], (_req, res) => {
        res.type('application/javascript').send(buildEmbedAppScript());
    });

    app.get('/img/studio-app/:name.svg', (req, res) => {
        const name = String(req.params.name || '');
        const entry = loadState().entries[name] || null;
        res.type('image/svg+xml');
        // Menu icons are fetched by every user's browser on every page load;
        // let them cache briefly but revalidate so a rename shows up soon.
        res.set('Cache-Control', 'public, max-age=300');
        res.send(buildEntryIconSvg(entry ? entry.displayName : null));
    });
}

module.exports = {
    syncStudioAppMenus,
    startPolling,
    registerRoutes,
    // exported for tests
    menuNameForAppId,
    appIdForMenuName,
    buildEmbedAppScript,
    buildEntryIconSvg,
    fetchDesiredApps,
    loadState,
    STATE_FILE,
};
