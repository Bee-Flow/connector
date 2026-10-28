// ESLint for nextcloud-connector/: the shared service floor
// (scripts/eslint-service-config.cjs). Run: npm run lint
const globals = require('globals');
const { serviceConfig } = require('../scripts/eslint-service-config.cjs');

// public/ is the built SPA the Dockerfile copies in (gitignored here).
module.exports = serviceConfig(globals, {
    ignores: ['public/**'],
    // One logger (src/log.js): JSON lines in production, console in dev and tests.
    extra: [{ files: ['src/**/*.js'], rules: { 'no-console': 'error' } }],
});
