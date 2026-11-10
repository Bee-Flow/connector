/**
 * The texts of choosing a Bee Flow server on the setup page, in English (the
 * source language; l10n/<lang>.json holds the translations, see l10n.js).
 * setup.js hands them to the page in the administrator's Nextcloud language.
 */

'use strict';

// Where the self-hosted card points for running a Bee Flow server: the
// documentation site the App Store description already links to.
const SELF_HOSTING_DOCS_URL = 'https://docs.beeflow.ai/self-hosting';

// The texts of the choice itself. The page gets them from GET /setup/status.
// `{host}` is filled in by the page with the host of the server about to be
// chosen.
const SETUP_TEXTS = {
    consent: 'When you connect, the names and e-mail addresses of this Nextcloud\'s administrators, its address, '
        + 'instance id and version are sent to {host}, an organisation is created there, and users and groups are '
        + 'synchronised afterwards. Nothing is sent before you press Connect.',
    selfHostingLink: 'How to run Bee Flow on your own server',
    literalCloudEnv: 'The install-time value BEEFLOW_API_BASE_URL holds the address https://server.beeflow.nl. '
        + 'That address there is not a choice. Choose Bee Flow Cloud below, or use the word cloud as the '
        + 'install-time value to fix Bee Flow Cloud.',
};

// The same sentence for the admin settings form (declarativeSettings.js),
// where the server is a radio button and there is no Connect button.
const SETTINGS_FORM_CONSENT = 'When you choose a server here, the names and e-mail addresses of this Nextcloud\'s '
    + 'administrators, its address, instance id and version are sent to that server, an organisation is created there, '
    + 'and users and groups are synchronised afterwards. Nothing is sent before you make that choice.';

// The failures of a choice that have a name. Each is one sentence an
// administrator can act on: no command, no address.
const CONNECT_ERRORS = {
    server_unreachable: 'The Bee Flow server could not be reached from this Nextcloud. '
        + 'Check the address and that the server is running, then try again.',
    certificate_not_trusted: 'The certificate of the Bee Flow server is not trusted. '
        + 'Give the server a certificate from a public certificate authority, or put the certificate of your own '
        + 'certificate authority in the install-time value BEEFLOW_SERVER_CA_CERT, then try again.',
    version_mismatch: 'This Bee Flow server and this connector do not work together in these versions. '
        + 'Update both to their latest release, then try again.',
    pairing_code_required: 'This Bee Flow server asks for a pairing code. Generate one in Bee Flow '
        + '(Settings → Organisation → Pair a new Nextcloud), enter it here and connect again.',
    pairing_code_invalid: 'This Bee Flow server does not accept this pairing code: it is mistyped, expired or already used. '
        + 'Generate a new one in Bee Flow (Settings → Organisation → Pair a new Nextcloud), enter it here and connect again.',
};
/** @typedef {keyof typeof CONNECT_ERRORS} ConnectErrorCode */

// Bootstrap failure category (bootstrap.js) → the named failure it is shown as.
/** @type {Record<string, ConnectErrorCode>} */
const CATEGORY_TO_CONNECT_ERROR = {
    saas_unreachable: 'server_unreachable',
    saas_cert_untrusted: 'certificate_not_trusted',
    pairing_required: 'pairing_code_required',
    pairing_code_invalid: 'pairing_code_invalid',
    connector_outdated: 'version_mismatch',
    version_mismatch: 'version_mismatch',
};

module.exports = { SETUP_TEXTS, SETTINGS_FORM_CONSENT, CONNECT_ERRORS, CATEGORY_TO_CONNECT_ERROR, SELF_HOSTING_DOCS_URL };
