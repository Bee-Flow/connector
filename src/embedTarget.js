/**
 * Where the embedded app's SPA shell (index.html + assets) comes from, decided
 * per request so it follows a runtime switch of the Bee Flow server (#401).
 *
 * A switch to self-hosted (the /setup picker or the admin settings form) used
 * to change only the API target, so the shell kept coming from beeflow.nl:
 * the Cloud frontend build running against the customer's own server, and a
 * request to Bee Flow on every page load of a self-hosted install. Now:
 *
 *   1. BEEFLOW_EMBED_BASE_URL naming a host other than Cloud's frontend is the
 *      admin's lock (config.embedBaseUrlLocked) and always wins.
 *   2. While the connector talks to Bee Flow Cloud, the shell comes from
 *      Cloud's frontend.
 *   3. While it talks to a self-hosted server, the shell comes from that
 *      server's web app URL, saved next to the server URL in either picker.
 *      It is used only while that same server is the live one, so a failed
 *      switch can never pair one server's API with another's frontend.
 *   4. A self-hosted server without a web app URL gets the shell baked into
 *      this image (null here). No request goes to beeflow.nl.
 */

'use strict';

const setupConfig = require('./setupConfig');

/** @returns {string | null} the shell host, or null for the baked shell */
function shellBaseUrl() {
    // Read per call, not at import: the live config object is the one the
    // pickers write to (and the one a test rebuilds).
    const config = require('./config');
    if (config.embedBaseUrlLocked) return config.embedBaseUrl;
    if (config.apiBaseUrl === setupConfig.CLOUD_URL) return setupConfig.CLOUD_EMBED_URL;
    const stored = setupConfig.get();
    if (stored?.embedBaseUrl && stored.apiBaseUrl === config.apiBaseUrl) return stored.embedBaseUrl;
    return null;
}

module.exports = { shellBaseUrl };
