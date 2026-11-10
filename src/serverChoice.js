/**
 * Which Bee Flow server does this connector talk to?
 *
 * The connector has no server until an administrator chooses one. Before that
 * choice nothing is sent to any Bee Flow server and nothing is created
 * anywhere: no bootstrap, no shell request, no proxied call. An install that is
 * already connected keeps its server without a new step.
 *
 * The answer is worked out once at boot, read-only (this file never writes or
 * deletes anything), from what the install already holds. First match wins:
 *
 *   1. env-lock        BEEFLOW_API_BASE_URL is the word `cloud` (Bee Flow
 *                      Cloud) or the URL of a server. What is typed there is
 *                      fixed: neither the setup page nor the settings form
 *                      changes it.
 *   2. binding         (auto tenant key only) tenant-key.json holds a key. The
 *                      server is the one that issued it (`boundApiBaseUrl`); a
 *                      cache written before that field existed resolves to the
 *                      saved choice, else Bee Flow Cloud (`legacy-binding`).
 *   3. picker          setup-config.json holds a server: the administrator
 *                      chose one on the setup page or in the settings form.
 *   4. legacy-env-key  an explicit BEEFLOW_TENANT_KEY next to the literal
 *                      Cloud URL in BEEFLOW_API_BASE_URL: a key pasted for an
 *                      organisation on Bee Flow Cloud.
 *   5. none            no server. The connector waits for an administrator.
 *
 * The literal Cloud URL in BEEFLOW_API_BASE_URL is not a choice by itself
 * (rule 1 skips it): AppAPI keeps replaying the value it stored at install
 * time, also when nobody typed it. An administrator who wants Bee Flow Cloud
 * fixed at install time types the word `cloud`.
 *
 * Invariant: no server means no tenant key in memory. Every guard that already
 * exists for "no key yet" (minting a token, signing a callback, the /nc/*
 * proxy, the task poller, the menu sync) therefore also covers "no server".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseAllowedUrl } = require('./remoteHost');
const log = require('./log');
const { errMessage } = require('./errors');

const CLOUD_API_BASE_URL = 'https://server.beeflow.nl';
// The word that selects Bee Flow Cloud in BEEFLOW_API_BASE_URL.
const CLOUD_KEYWORD = 'cloud';
// A value AppAPI can replay without anybody having typed it. Never a lock,
// and by itself never a choice.
const LEGACY_CLOUD_ENV = CLOUD_API_BASE_URL;
const CACHE_FILE = 'tenant-key.json';
// What every refusal in the not-chosen state carries, so the embedded app and
// an operator can tell it from a failure.
const NOT_CHOSEN_CODE = 'server_not_chosen';
const NOT_CHOSEN_MESSAGE = 'Bee Flow is not set up yet: an administrator has to choose where it runs.';

/**
 * @typedef {'env-lock' | 'binding' | 'legacy-binding' | 'picker' | 'legacy-env-key' | 'none'} ServerSource
 * @typedef {{ url: string | null, source: ServerSource, locked: boolean }} ServerChoice
 */

/** @param {unknown} value */
const trimUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

/**
 * Is this the literal Cloud URL (any spelling of that origin without a path)?
 * @param {string} value
 */
function isLegacyCloudEnv(value) {
    try {
        const u = new URL(value);
        return u.origin === LEGACY_CLOUD_ENV && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    } catch {
        return false;
    }
}

/**
 * Rule 1, on the raw value of BEEFLOW_API_BASE_URL.
 * @param {unknown} raw
 * @returns {{ url: string | null, legacyCloud: boolean, invalid: string | null }}
 *   url: the locked server, or null when the value locks nothing;
 *   legacyCloud: the value is the literal Cloud URL;
 *   invalid: why a non-empty value was ignored.
 */
function envLock(raw) {
    const value = trimUrl(raw);
    if (!value) return { url: null, legacyCloud: false, invalid: null };
    if (value.toLowerCase() === CLOUD_KEYWORD) return { url: CLOUD_API_BASE_URL, legacyCloud: false, invalid: null };
    if (isLegacyCloudEnv(value)) return { url: null, legacyCloud: true, invalid: null };
    try {
        parseAllowedUrl(value, { label: 'BEEFLOW_API_BASE_URL' });
    } catch (err) {
        return { url: null, legacyCloud: false, invalid: errMessage(err) };
    }
    return { url: value, legacyCloud: false, invalid: null };
}

/**
 * tenant-key.json, when it holds a key. Read-only and synchronous: an
 * unreadable or keyless file is "no binding", never a reason to write.
 * @param {string} storageDir
 * @returns {{ tenantKey: string, boundApiBaseUrl?: string } | null}
 */
function readBinding(storageDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(storageDir, CACHE_FILE), 'utf8'));
        if (parsed && typeof parsed.tenantKey === 'string' && parsed.tenantKey) return parsed;
    } catch { /* missing or unreadable: no binding */ }
    return null;
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {string} input.storageDir
 * @param {{ apiBaseUrl?: string } | null | undefined} input.setupConfig  what setup-config.json holds
 * @param {boolean} input.isAutoTenantKey
 * @returns {ServerChoice}
 */
function resolveServerChoice({ env, storageDir, setupConfig, isAutoTenantKey }) {
    const fromEnv = envLock(env.BEEFLOW_API_BASE_URL);
    if (fromEnv.url) return { url: fromEnv.url, source: 'env-lock', locked: true };

    const saved = trimUrl(setupConfig?.apiBaseUrl) || null;

    if (isAutoTenantKey) {
        const binding = readBinding(storageDir);
        if (binding) {
            const bound = trimUrl(binding.boundApiBaseUrl);
            if (bound) return { url: bound, source: 'binding', locked: false };
            return { url: saved || CLOUD_API_BASE_URL, source: 'legacy-binding', locked: false };
        }
    }

    if (saved) return { url: saved, source: 'picker', locked: false };

    if (!isAutoTenantKey && fromEnv.legacyCloud) {
        return { url: CLOUD_API_BASE_URL, source: 'legacy-env-key', locked: false };
    }

    return { url: null, source: 'none', locked: false };
}

/**
 * Apply the resolved choice to the live config, once, at boot.
 *
 * Sets the server and where it came from, and keeps the invariant: an explicit
 * BEEFLOW_TENANT_KEY is put in memory only when a server is known, and no
 * server means no key.
 * @param {import('./config').ConnectorConfig} config
 * @param {{ apiBaseUrl?: string } | null | undefined} stored  setupConfig.init()'s result
 * @returns {ServerChoice}
 */
function applyAtBoot(config, stored) {
    const choice = resolveServerChoice({
        env: process.env,
        storageDir: config.persistentStorage,
        setupConfig: stored,
        isAutoTenantKey: config.isAutoTenantKey,
    });
    config.apiBaseUrl = choice.url;
    config.serverSource = choice.source;
    config.tenantKey = choice.url ? config.envTenantKey : null;
    if (choice.url) {
        log.info(`[ServerChoice] Bee Flow server: ${choice.url} (${choice.source})`);
    } else {
        log.info('[ServerChoice] No Bee Flow server chosen; nothing is sent until an administrator chooses one');
    }
    return choice;
}

/**
 * An Error carrying the not-chosen code, for the code paths that would
 * otherwise go on to contact a server.
 * @returns {Error}
 */
function notChosenError() {
    const e = new Error(NOT_CHOSEN_MESSAGE);
    e.code = NOT_CHOSEN_CODE;
    return e;
}

// Served by the connector itself, never fetched from a Bee Flow host.
const LOCAL_PATHS = new Set(['/js/embed', '/js/embed.js', '/img/app.svg']);

/**
 * The gate of the not-chosen state. While a server is chosen it does nothing.
 *
 * While none is:
 *   - the connector's own embed script and menu icon pass;
 *   - a page load (`/`, `/index.html`, any document navigation) gets the setup
 *     page in first-run mode, so the choice is made on the URL Nextcloud frames.
 *     An administrator gets the picker; everybody else a short notice, and that
 *     page then makes no request at all;
 *   - everything else is refused here: nothing is proxied and no shell asset is
 *     fetched.
 *
 * The refusal is a 503 on purpose. A normal page load makes none of these
 * calls, and HaRP counts an ExApp's own answer against the client address only
 * on a route that declares bruteforce_protection in info.xml, which no route
 * behind this gate does.
 *
 * @param {{ pageHtml: () => string | null }} options  the setup page's source; null when it cannot be read
 * @returns {import('express').RequestHandler}
 */
function unconfiguredGate({ pageHtml }) {
    // Lazy: config requires this file, and auth requires config.
    const config = require('./config');
    const { isDocumentNavigation } = require('./auth');
    const { isNoncePath, withNonceRoom } = require('./htmlPadding');
    return (req, res, next) => {
        if (config.apiBaseUrl) return next();
        if (LOCAL_PATHS.has(req.path)) return next();
        const isGet = req.method === 'GET' || req.method === 'HEAD';
        if (isGet && (req.path === '/' || req.path === '/index.html' || isDocumentNavigation(req))) {
            const html = pageHtml();
            if (html === null) {
                return res.status(500).type('text/plain').send('setup.html missing — connector packaging error');
            }
            res.set('Cache-Control', 'no-store');
            const page = firstRunPage(html, !!req.beeflow?.user?.isNcAdmin);
            // `/index.html` is what the Nextcloud top bar frames on a
            // manual-install daemon; see htmlPadding.js.
            return res.type('html').send(isNoncePath(req.path) ? withNonceRoom(page) : page);
        }
        return res.status(503).json({ error: NOT_CHOSEN_MESSAGE, code: NOT_CHOSEN_CODE });
    };
}

/**
 * The gate of the state "a server is chosen, connecting to it failed, and
 * there is no key". Whenever `connectFailed()` says no, it does nothing.
 *
 * While it says yes, a page load (`/`, `/index.html`, any document navigation)
 * gets the setup page, where the connection is finished: an administrator
 * gets the whole page, with the failure and what to do about it; everybody
 * else a short notice, and that page makes no request at all. Every other
 * request passes as before.
 *
 * @param {{ pageHtml: () => string | null, connectFailed: () => boolean }} options
 * @returns {import('express').RequestHandler}
 */
function connectFailedGate({ pageHtml, connectFailed }) {
    const { isDocumentNavigation } = require('./auth');
    const { isNoncePath, withNonceRoom } = require('./htmlPadding');
    return (req, res, next) => {
        if (!connectFailed()) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (LOCAL_PATHS.has(req.path) || req.path.startsWith('/setup')) return next();
        if (!(req.path === '/' || req.path === '/index.html' || isDocumentNavigation(req))) return next();
        const html = pageHtml();
        if (html === null) return next();
        res.set('Cache-Control', 'no-store');
        const page = connectFailedPage(html, !!req.beeflow?.user?.isNcAdmin);
        return res.type('html').send(isNoncePath(req.path) ? withNonceRoom(page) : page);
    };
}

/**
 * The setup page for the connect-failed state: complete for an administrator,
 * the notice (first-run mode without `data-can-configure`) for everybody else.
 * @param {string} html
 * @param {boolean} isAdmin
 */
function connectFailedPage(html, isAdmin) {
    return html.replace('<body>', isAdmin ? '<body data-connect-failed>' : '<body data-first-run data-connect-failed>');
}

/**
 * The setup page in first-run mode. `data-can-configure` is set for a
 * Nextcloud administrator only: without it the page shows its notice and its
 * script stops before the first request.
 * @param {string} html
 * @param {boolean} canConfigure
 */
function firstRunPage(html, canConfigure) {
    return html.replace('<body>', canConfigure ? '<body data-first-run data-can-configure>' : '<body data-first-run>');
}

module.exports = {
    resolveServerChoice,
    applyAtBoot,
    unconfiguredGate,
    connectFailedGate,
    connectFailedPage,
    envLock,
    notChosenError,
    firstRunPage,
    CLOUD_API_BASE_URL,
    CLOUD_KEYWORD,
    LEGACY_CLOUD_ENV,
    NOT_CHOSEN_CODE,
    NOT_CHOSEN_MESSAGE,
};
