/**
 * Studio-app top-menu publication.
 *
 * Bee Flow's App Studio lets an owner publish an app "to the Nextcloud app
 * menu". This module is the Nextcloud half of that feature: it polls the SaaS
 * for the org's opted-in published apps and reconciles that list against
 * AppAPI's `ui/top-menu` registrations, so each app gets its own icon in the
 * Nextcloud top bar and opens on its own embedded page
 * (`/apps/app_api/embedded/bee_flow/sa_<base32 app id>`).
 *
 * Flow per entry:
 *   1. POST /ocs/v1.php/apps/app_api/api/v1/ui/top-menu    {name:'sa_<b32>', displayName, icon}
 *   2. POST /ocs/v1.php/apps/app_api/api/v1/ui/script      {type:'top_menu', name:'sa_<b32>', path:'js/embed-app'}
 *   3. NC injects js/embed-app.js into the entry's embedded page; the script
 *      decodes the app id back out of the entry name in the page URL (see the
 *      encoding note below) and mounts an iframe at the signed proxy with
 *      `?ncStudioApp=<appId>`, which the SPA resolves to its standalone
 *      app-run view.
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

// ── Nextcloud column limits — HARD, and silent when exceeded ────────
// `oc_ex_ui_top_menu`.name AND .display_name are both varchar(32). Over-long
// values do not truncate: AppAPI answers OCS statuscode 400 ("Top Menu entry
// could not be registered") while still returning HTTP 200, so an unchecked
// caller reads it as success. Both limits are enforced here, and ocsCall below
// reads the OCS envelope so a future violation is loud instead of invisible.
const MAX_NAME = 32;
const MAX_DISPLAY_NAME = 32;

// ── Menu-name mapping ───────────────────────────────────────────────
// App ids are crypto.randomUUID() (8-4-4-4-12 lowercase hex). The entry name
// carries the id so the embedded page script can reconstruct it from the page
// URL alone — no per-entry state has to reach the browser.
//
// The id is encoded as lowercase BASE32 (RFC 4648 alphabet, no padding): 128
// bits → 26 chars, so `sa_` + 26 = 29, inside the 32-char column with room to
// spare. Hex would be 32 chars and `sa_` + hex = 35, which is what made every
// registration fail. Lowercase-alphanumeric is also the safest charset here —
// it matches the existing `main` entry and needs no escaping in the embedded
// URL path segment.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function menuNameForAppId(appId) {
    const hex = String(appId || '').toLowerCase().replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/.test(hex)) return null;
    let out = '';
    let acc = 0;
    let nbits = 0;
    for (let i = 0; i < hex.length; i += 2) {
        acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16);
        nbits += 8;
        while (nbits >= 5) {
            out += B32[(acc >> (nbits - 5)) & 31];
            nbits -= 5;
        }
    }
    if (nbits > 0) out += B32[(acc << (5 - nbits)) & 31];
    const name = `sa_${out}`;
    // Belt and braces: never hand Nextcloud a name the column cannot hold.
    return name.length <= MAX_NAME ? name : null;
}

function appIdForMenuName(name) {
    const m = /^sa_([a-z2-7]{26})$/.exec(String(name || ''));
    if (!m) return null;
    let hex = '';
    let acc = 0;
    let nbits = 0;
    for (const ch of m[1]) {
        const v = B32.indexOf(ch);
        if (v < 0) return null;
        acc = (acc << 5) | v;
        nbits += 5;
        while (nbits >= 8) {
            const byte = (acc >> (nbits - 8)) & 255;
            hex += byte.toString(16).padStart(2, '0');
            nbits -= 8;
        }
    }
    if (hex.length !== 32) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Fit a display name into the column. Truncation is visible ("…") rather than
 * silent, because the alternative — what shipped in 1.4.0 — was AppAPI
 * refusing the whole entry for a long app name and nothing saying why.
 */
function fitDisplayName(displayName) {
    const clean = String(displayName || '').trim() || 'App';
    return clean.length <= MAX_DISPLAY_NAME ? clean : `${clean.slice(0, MAX_DISPLAY_NAME - 1)}…`;
}

// ── Persisted registration state ────────────────────────────────────

function statePath() {
    return path.join(config.persistentStorage, STATE_FILE);
}

function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        if (!raw || typeof raw.entries !== 'object' || raw.entries === null) return { entries: {} };
        // Drop entries whose name predates the current encoding. 1.4.0 wrote
        // `sa_<32 hex>` (35 chars) into this file as "registered" while
        // Nextcloud had actually refused every one of them — the name could
        // not fit varchar(32). They therefore do not exist on the NC side and
        // must not be carried forward, or every sync would try (and fail) to
        // unregister a row that was never there.
        const entries = {};
        for (const [name, entry] of Object.entries(raw.entries)) {
            if (appIdForMenuName(name)) entries[name] = entry;
        }
        return { ...raw, entries };
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

/**
 * OCS statuscodes that mean "the desired end state holds".
 *   100 / 200 — success (v1 / v2 envelopes)
 *   409       — already registered; re-running a sync must be idempotent
 * On a DELETE, 404 additionally means "already gone".
 */
const OCS_OK = new Set([100, 200, 409]);

/** Pull `ocs.meta.statuscode` out of a JSON *or* XML envelope; null if absent. */
function readOcsStatus(text) {
    try {
        const code = JSON.parse(text)?.ocs?.meta?.statuscode;
        if (Number.isFinite(code)) return code;
    } catch (_) { /* not JSON — try the XML shape below */ }
    const m = /<statuscode>(\d+)<\/statuscode>/.exec(text || '');
    return m ? parseInt(m[1], 10) : null;
}

/**
 * One OCS call, checked properly.
 *
 * OCS answers HTTP 200 even when it refuses the request — the real outcome is
 * `ocs.meta.statuscode` in the body. Reading only the HTTP status is what let
 * 1.4.0 report "registered" for entries Nextcloud had rejected outright, and
 * then persist them as done so they were never retried. Both layers are
 * checked here, and the thrown error carries the OCS code so the log names the
 * actual reason.
 */
async function ocsCall(method, url, body, label) {
    const res = await withWarmupRetry(() => fetch(url, {
        method,
        headers: appApiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    }), { label, budgetMs: 30_000 });

    const text = await res.text().catch(() => '');
    const code = readOcsStatus(text);
    const httpOk = res.ok || res.status === 409 || (method === 'DELETE' && res.status === 404);
    const ocsOk = code === null
        ? httpOk // no envelope to read — the HTTP status is all we have
        : (OCS_OK.has(code) || (method === 'DELETE' && code === 404));

    if (!httpOk || !ocsOk) {
        throw new Error(
            `${label} HTTP ${res.status}${code === null ? '' : ` / OCS ${code}`}: ${text.slice(0, 200)}`,
        );
    }
}

async function registerEntry(name, displayName) {
    const base = `${config.nextcloudUrl}/ocs/v1.php/apps/app_api/api/v1/ui`;
    await ocsCall('POST', `${base}/top-menu`, {
        name,
        displayName: fitDisplayName(displayName),
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
    // Mirror of appIdForMenuName(): base32 (RFC 4648, lowercase, no padding)
    // back to the UUID. Kept in lockstep with the server side — the entry name
    // in this URL is the ONLY thing identifying which app to open.
    var B32 = 'abcdefghijklmnopqrstuvwxyz234567';
    var m = (window.location.pathname || '').match(/\\/embedded\\/[^/]+\\/(sa_[a-z2-7]{26})/);
    var appId = null;
    if (m) {
        var s = m[1].slice(3), acc = 0, nbits = 0, hex = '';
        for (var i = 0; i < s.length; i++) {
            var v = B32.indexOf(s.charAt(i));
            if (v < 0) { hex = ''; break; }
            acc = (acc << 5) | v;
            nbits += 5;
            while (nbits >= 8) {
                var byte = (acc >> (nbits - 8)) & 255;
                hex += (byte < 16 ? '0' : '') + byte.toString(16);
                nbits -= 8;
            }
        }
        if (hex.length === 32) {
            appId = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
                + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        }
    }
    if (!appId) {
        content.textContent = 'This Bee Flow app could not be loaded (invalid app link).';
        return;
    }
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

// ── Lucide icon resolution ──────────────────────────────────────────
// A Studio app's `icon` is a Lucide icon NAME in PascalCase ('Contact',
// 'LayoutGrid', 'Building2') — the same name the Bee Flow web app renders, so
// the Nextcloud top bar shows the icon the owner actually picked rather than a
// stand-in. lucide-static ships one SVG per icon, kebab-cased; the Dockerfile
// keeps only that directory (see the prune there).
const LUCIDE_ICON_DIR = (() => {
    try {
        return path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons');
    } catch (_) {
        return null; // dependency absent (e.g. a slimmed image) → letter tiles
    }
})();

/** 'LayoutGrid' → 'layout-grid', 'Building2' → 'building-2'. */
function lucideFileName(iconName) {
    return String(iconName || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([a-zA-Z])(\d)/g, '$1-$2')
        .toLowerCase();
}

const _iconCache = new Map();

/**
 * The app's own Lucide glyph, or null when it cannot be resolved.
 *
 * The name is normalised to a kebab file name and then hard-validated against
 * `[a-z0-9-]+` before it touches the filesystem: it arrives from the SaaS, so
 * a crafted value must not be able to walk out of the icons directory.
 * `currentColor` is pinned to black because Nextcloud recolors menu icons with
 * a CSS filter over a standalone SVG, where `currentColor` has no context to
 * inherit from.
 */
function lucideIconSvg(iconName) {
    if (!LUCIDE_ICON_DIR || !iconName) return null;
    const file = lucideFileName(iconName);
    if (!/^[a-z0-9-]+$/.test(file)) return null;
    if (_iconCache.has(file)) return _iconCache.get(file);
    let svg = null;
    try {
        svg = fs.readFileSync(path.join(LUCIDE_ICON_DIR, `${file}.svg`), 'utf8')
            .replace(/currentColor/g, '#000000');
    } catch (_) {
        svg = null; // unknown icon name — the caller falls back to the letter
    }
    _iconCache.set(file, svg);
    return svg;
}

/**
 * Monochrome top-bar icon for one entry: the app's own Lucide glyph when the
 * name resolves, otherwise the app's first letter in a rounded tile. Nextcloud
 * recolors menu icons via CSS filters, so either way the shape must be plain
 * dark on transparent — never the app's accent color. The letter comes from
 * the connector's own persisted state (display names never leave the org's
 * Nextcloud), with a neutral fallback when state is missing.
 */
function buildEntryIconSvg(displayName, iconName) {
    const lucide = lucideIconSvg(iconName);
    if (lucide) return lucide;
    return buildLetterIconSvg(displayName);
}

function buildLetterIconSvg(displayName) {
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
        res.send(buildEntryIconSvg(entry ? entry.displayName : null, entry ? entry.icon : null));
    });
}

module.exports = {
    syncStudioAppMenus,
    startPolling,
    registerRoutes,
    // exported for tests
    menuNameForAppId,
    appIdForMenuName,
    fitDisplayName,
    MAX_NAME,
    MAX_DISPLAY_NAME,
    buildEmbedAppScript,
    buildEntryIconSvg,
    buildLetterIconSvg,
    lucideFileName,
    lucideIconSvg,
    fetchDesiredApps,
    loadState,
    STATE_FILE,
};
