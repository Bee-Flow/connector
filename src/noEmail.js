/**
 * A Nextcloud account without an e-mail address.
 *
 * Bee Flow signs a user in by e-mail address, so an account that has none
 * cannot use the web app. Such a user gets a clear answer from the connector
 * itself, in their Nextcloud language: a small page for a page load, and 403
 * with code `no_email` for a call the web app makes.
 *
 * Only the web app and the calls it proxies are answered here. The setup
 * routes, diagnostics and the lifecycle routes are mounted before this gate
 * and work for an account without an address. While the connector has no
 * tenant key the gate stays out of the way as well: the web app is then the
 * setup screen an administrator finishes connecting on.
 */

'use strict';

const auth = require('./auth');
const l10n = require('./l10n');
const { isSpaShellPath } = require('./proxy');
const { isConnectorSetupPath } = require('./requestText');

const NO_EMAIL_CODE = 'no_email';

// English is the source language; l10n/<lang>.json holds the translations.
const NO_EMAIL_TEXTS = {
    title: 'Your Nextcloud account has no e-mail address',
    body: 'Bee Flow needs an e-mail address to sign you in. Add one in Nextcloud under Personal settings, '
        + 'or ask your administrator to add it, then reload this page.',
};

/** @param {string} value */
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page a user without an e-mail address gets instead of the web app. No
 * script and no request of its own.
 * @param {string} lang  a language l10n.js has a dictionary for, or 'en'
 * @returns {string}
 */
function noEmailPage(lang) {
    const title = escapeHtml(l10n.t(lang, NO_EMAIL_TEXTS.title));
    const body = escapeHtml(l10n.t(lang, NO_EMAIL_TEXTS.body));
    return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bee Flow</title>
<style>
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 520px; margin: 12vh auto 0; padding: 28px 32px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; }
    h1 { margin: 0 0 12px; font-size: 20px; line-height: 1.3; }
    p { margin: 0; font-size: 15px; line-height: 1.55; color: #475569; }
</style>
</head>
<body data-no-email>
<main>
<h1>${title}</h1>
<p>${body}</p>
</main>
</body>
</html>
`;
}

/**
 * Mounted after the setup and lifecycle routes and before the API proxy and
 * the web app.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function noEmailGate(req, res, next) {
    const context = req.beeflow;
    // No user (an anonymous asset request), a user with an address, or no
    // tenant key yet: not this gate's business.
    if (!context || !context.user || context.user.email || !context.jwt) return next();
    if (isConnectorSetupPath(req.path)) return next();

    const lang = l10n.normaliseLanguage(context.user.language);
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (isGet && (req.path === '/' || req.path === '/index.html' || auth.isDocumentNavigation(req))) {
        // The next page load asks Nextcloud again, so an address added in the
        // meantime counts at once.
        auth.forgetUser(context.user.uid);
        res.set('Cache-Control', 'no-store');
        return res.type('html').send(noEmailPage(lang));
    }
    // The web app's own static files carry nothing about the user.
    if (isGet && isSpaShellPath(req.path)) return next();
    return res.status(403).json({ code: NO_EMAIL_CODE, error: l10n.t(lang, NO_EMAIL_TEXTS.title) });
}

module.exports = { noEmailGate, noEmailPage, NO_EMAIL_TEXTS, NO_EMAIL_CODE };
