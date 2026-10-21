/**
 * Bee Flow entries in the Files right-click menu.
 *
 * WHY THIS IS THE CHEAPEST AMBIENT SURFACE THERE IS: everything else that puts
 * an app inside Nextcloud's own UI — reference providers for the smart picker,
 * a Files sidebar tab, a Dashboard widget — needs a PHP app, because AppAPI
 * exposes no registration for them (`registerReferenceProvider` appears nowhere
 * in app_api). File actions are the exception. AppAPI's own
 * `LoadFilesPluginListener` mounts its Files plugin only *if some ExApp has
 * registered a file action*, so one OCS call is the whole integration:
 *
 *   POST /ocs/v2.php/apps/app_api/api/v2/ui/files-actions-menu
 *
 * Then Nextcloud POSTs `{files: [nodeInfo, …]}` to
 * `/apps/app_api/proxy/<appId>/<actionHandler>` when a user picks the entry,
 * and — for v2 handlers — if we answer with `{redirect_handler}` it navigates
 * to `/apps/app_api/embedded/<appId>/<redirect_handler>?fileIds=<ids>`.
 * `execBatch` sends the whole multi-select in one call, so selecting twelve
 * files is one request, not twelve.
 *
 * WHAT APPAPI SUPPORTS, read from app_api's own source (NC 35 sandbox,
 * lib/Service/UI/FilesActionsMenuService.php, js/app_api-filesplugin.js,
 * lib/Controller/TopMenuController.php):
 *
 *   - An entry is registered per ExApp, for EVERY user of the instance. There
 *     is no per-user registration, no per-user visibility and no dynamic
 *     label: `displayName` is one static string (translated through the
 *     ExApp's l10n). No submenus.
 *   - Visibility is decided in the browser by `mime` alone: a comma-separated
 *     list, and an entry shows when EVERY selected node's mimetype CONTAINS
 *     one of the entries (substring match). A folder's mimetype is
 *     `httpd/unix-directory`. `permissions` is stored but the NC 35 plugin
 *     does not check it.
 *   - The handler receives `{ files: [nodeInfo, …] }`; a node carries
 *     `fileId`, `name` (basename), `directory` (dirname), `mime`,
 *     `fileType` ('file' | 'folder'), `permissions`, `userId`, … but NO
 *     `path` and NOT the name of the entry that was clicked: one handler path
 *     per entry is the only way to tell entries apart.
 *   - A v2 handler may answer `{ redirect_handler: '<name>[/<rest>]' }`; the
 *     browser then goes to `/apps/app_api/embedded/<appId>/<redirect_handler>
 *     ?fileIds=<ids>`. That page 404s unless `<name>` is a REGISTERED TOP-MENU
 *     entry, and it runs that entry's scripts; `<rest>` is free.
 *
 * KNOWN INCOMPLETE, deliberately: the redirect lands on the Bee Flow SPA with
 * `?fileIds=` in the query, and the SPA does not read that parameter yet. So
 * today these entries open Bee Flow; they do not yet open it *with the file in
 * context*. The connector half is what makes AppAPI mount the plugin at all,
 * and it is useless to ship the SPA half first — but the feature is not
 * finished until `Bee-Flow/hive` consumes `fileIds`.
 */

const config = require('./config');
const { withWarmupRetry } = require('./appApiClient');

const UI_API = '/ocs/v2.php/apps/app_api/api/v2/ui/files-actions-menu';
const UI_API_V1 = '/ocs/v2.php/apps/app_api/api/v1/ui/files-actions-menu';

// Route the Files plugin POSTs to. Covered by info.xml's catch-all USER route,
// which is correct: this is a user-initiated action and must carry their
// identity, not the app's.
const HANDLER_PATH = '/files-action';
// Entries an earlier build registered and this one no longer offers. AppAPI
// keeps an entry until someone deletes it, so the connector deletes these on
// every start: "Start a Bee Flow automation…" (the Files start of Studio →
// Automations handoff 5) was removed again before it reached a release.
const RETIRED_ACTION_NAMES = Object.freeze(['beeflow_app_button']);

/**
 * `permissions` is Nextcloud's bitmask; 1 = READ. Every entry here only reads,
 * so requiring READ means the action appears on files a user can open and not
 * on ones they cannot — including inside a share they were given read-only.
 *
 * NOTE: whether Nextcloud enforces this server-side or only uses it to filter
 * the menu is UNVERIFIED. Treat it as presentation, not authorisation — the
 * handler must still behave as if anyone could call it, which it does: the
 * request arrives with the user's own session and everything downstream is
 * scoped to them.
 */
const PERM_READ = 1;

const ACTIONS = [
    {
        name: 'beeflow_ask',
        displayName: 'Ask Bee Flow about this',
        actionHandler: HANDLER_PATH.replace(/^\//, ''),
        icon: 'img/app.svg',
        mime: 'file',
        permissions: PERM_READ,
        order: 10,
    },
    {
        name: 'beeflow_summarise',
        displayName: 'Summarise with Bee Flow',
        actionHandler: HANDLER_PATH.replace(/^\//, ''),
        icon: 'img/app.svg',
        // Only offered on things with text in them. Nextcloud matches this
        // against the node's mimetype, so putting "Summarise" on a .zip is a
        // menu entry that can only disappoint.
        mime: 'text',
        permissions: PERM_READ,
        order: 11,
    },
    {
        name: 'beeflow_automation',
        displayName: 'Run a Bee Flow automation…',
        actionHandler: HANDLER_PATH.replace(/^\//, ''),
        icon: 'img/app.svg',
        mime: 'file',
        permissions: PERM_READ,
        order: 12,
    },
];

function appApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        Accept: 'application/json',
        'EX-APP-ID': config.appId,
        'EX-APP-VERSION': config.appVersion,
        'AUTHORIZATION-APP-API': Buffer.from(`:${config.appSecret}`).toString('base64'),
    };
}

let _registered = false;

/** Register every entry. Idempotent — AppAPI upserts by (appId, name). */
async function registerFilesActions() {
    if (!config.tenantKey) {
        // Same rule as the Task Processing providers: an entry that lands the
        // user somewhere broken is worse than no entry.
        return { ok: false, reason: 'no-tenant-key', registered: 0 };
    }
    const url = `${config.nextcloudUrl}${UI_API}`;
    const results = await Promise.allSettled(ACTIONS.map(async (action) => {
        const res = await withWarmupRetry(() => fetch(url, {
            method: 'POST',
            headers: appApiHeaders(),
            body: JSON.stringify(action),
            signal: AbortSignal.timeout(5_000),
        }), { label: `files-action-${action.name}`, budgetMs: 20_000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return action.name;
    }));
    const registered = results.filter(r => r.status === 'fulfilled').length;
    if (registered > 0) _registered = true;
    await retireFilesActions();
    const failed = results.length - registered;
    console.log(`[FilesActions] ${registered}/${ACTIONS.length} menu entries registered`
        + (failed ? ` (${failed} failed — Nextcloud may predate the v2 UI API)` : ''));
    return { ok: failed === 0, registered, failed };
}

/** Delete the entries this connector no longer offers (RETIRED_ACTION_NAMES). Never throws. */
async function retireFilesActions() {
    if (!config.nextcloudUrl) return;
    // Deletion is v1-only: there is no v2 DELETE route.
    const url = `${config.nextcloudUrl}${UI_API_V1}`;
    await Promise.allSettled(RETIRED_ACTION_NAMES.map(name => fetch(url, {
        method: 'DELETE',
        headers: appApiHeaders(),
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(2_000),
    }).catch(() => {})));
}

async function unregisterFilesActions() {
    if (!config.nextcloudUrl || !_registered) return;
    // Deletion is v1-only — there is no v2 DELETE route.
    const url = `${config.nextcloudUrl}${UI_API_V1}`;
    await Promise.allSettled(ACTIONS.map(a => fetch(url, {
        method: 'DELETE',
        headers: appApiHeaders(),
        body: JSON.stringify({ name: a.name }),
        signal: AbortSignal.timeout(2_000),
    }).catch(() => {})));
}

/**
 * The node list Nextcloud sends, reduced to what we would act on.
 *
 * Defensive about shape on purpose: this payload is built by AppAPI's own
 * frontend (`buildNodeInfo`), so its exact keys are a moving target across
 * Nextcloud versions, and an entry that throws here would fail the user's click
 * with a console error they never see.
 */
function parseFiles(body) {
    const raw = Array.isArray(body?.files) ? body.files : [];
    return raw
        .map(f => ({
            fileId: f?.fileId ?? f?.fileid ?? f?.id ?? null,
            name: f?.name ?? null,
            // AppAPI sends `directory` + `name`, not `path` (buildNodeInfo).
            path: f?.path ?? joinPath(f?.directory, f?.name),
            mime: f?.mime ?? f?.mimetype ?? null,
            fileType: f?.fileType ?? f?.type ?? null,
        }))
        .filter(f => f.fileId != null);
}

/** `directory` + `name` as one absolute path, or null when either is missing. */
function joinPath(directory, name) {
    if (typeof directory !== 'string' || typeof name !== 'string' || !name) return null;
    const dir = directory.startsWith('/') ? directory : `/${directory}`;
    return `${dir.replace(/\/+$/, '')}/${name}`;
}

function registerRoutes(app) {
    app.post(HANDLER_PATH, (req, res) => {
        const files = parseFiles(req.body);
        if (!files.length) {
            // 200 rather than 4xx: the Files plugin logs a failure to the
            // browser console and shows the user nothing useful either way, so
            // there is no value in an error status — but do not redirect them
            // to a Bee Flow that has nothing to work on.
            return res.json({});
        }
        // '' is the SPA root; AppAPI appends ?fileIds=<comma-separated>.
        return res.json({ redirect_handler: '' });
    });
}

module.exports = {
    registerFilesActions,
    unregisterFilesActions,
    registerRoutes,
    retireFilesActions,
    parseFiles,
    ACTIONS,
    RETIRED_ACTION_NAMES,
    HANDLER_PATH,
};
