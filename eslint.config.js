// ESLint for nextcloud-connector/: the shared service floor
// (scripts/eslint-service-config.cjs). Run: npm run lint
const globals = require('globals');
const { serviceConfig } = require('../scripts/eslint-service-config.cjs');

// public/ is the built SPA the Dockerfile copies in (gitignored here). l10n/*.js
// are Nextcloud translation files (OC.L10N.register), run by Nextcloud's page.
module.exports = serviceConfig(globals, {
    ignores: ['public/**', 'l10n/**'],
    // One logger (src/log.js): JSON lines in production, console in dev and tests.
    extra: [{ files: ['src/**/*.js'], rules: { 'no-console': 'error' } }],
});
