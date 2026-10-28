/**
 * Translations for the messages the connector writes itself (#402).
 *
 * Nextcloud translates the STATIC strings (Files menu labels, the admin
 * settings form) in the browser from `l10n/<lang>.js`, which AppAPI copies
 * into the app folder on install and update. The connector's RUNTIME messages
 * (Talk bot replies, Assistant task errors) are sent as ready text, so the
 * connector picks the language itself: the user's Nextcloud `language`
 * preference, read with the user lookup auth.js already does (and caches).
 *
 * One dictionary for both: `l10n/<lang>.json`, keyed by the English text, the
 * format Nextcloud ships next to the .js. English is the source language and
 * has no file; a language without a file, an unknown key or a failed lookup
 * all fall back to English.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');
const { errMessage } = require('./errors');

const L10N_DIR = path.join(__dirname, '..', 'l10n');
const SOURCE_LANGUAGE = 'en';

/** @type {Map<string, Record<string, string> | null>} */
const _dictionaries = new Map();

/**
 * The translations for one language code ('nl'), or null when there is no file.
 * @param {string} lang
 * @returns {Record<string, string> | null}
 */
function dictionary(lang) {
    if (_dictionaries.has(lang)) return _dictionaries.get(lang) ?? null;
    /** @type {Record<string, string> | null} */
    let out = null;
    try {
        const raw = /** @type {{ translations?: Record<string, string> }} */ (JSON.parse(fs.readFileSync(path.join(L10N_DIR, `${lang}.json`), 'utf8')));
        out = raw && typeof raw.translations === 'object' ? raw.translations : null;
    } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if (code !== 'ENOENT') log.warn(`[l10n] could not read ${lang}.json: ${errMessage(err)}`);
    }
    _dictionaries.set(lang, out);
    return out;
}

/**
 * Nextcloud's language preference ('nl', 'nl_NL', 'de_DE', '') → a language
 * the connector has a dictionary for, or English.
 * @param {unknown} raw
 * @returns {string}
 */
function normaliseLanguage(raw) {
    const code = String(raw || '').trim().toLowerCase().replace('-', '_');
    if (!/^[a-z]{2,3}(_[a-z0-9]+)?$/.test(code)) return SOURCE_LANGUAGE;
    if (dictionary(code)) return code;
    const base = code.split('_')[0];
    return dictionary(base) ? base : SOURCE_LANGUAGE;
}

/**
 * `text` (the English source) in `lang`, or `text` itself.
 * @param {string} lang
 * @param {string} text
 * @returns {string}
 */
function t(lang, text) {
    if (!lang || lang === SOURCE_LANGUAGE) return text;
    const dict = dictionary(lang);
    const hit = dict ? dict[text] : undefined;
    return typeof hit === 'string' && hit ? hit : text;
}

/**
 * The language of a Nextcloud user, from their personal settings. English
 * when the user is unknown, has no preference, or the lookup fails: a reply
 * in English is better than no reply.
 * @param {string | null | undefined} uid
 * @returns {Promise<string>}
 */
async function userLanguage(uid) {
    if (!uid) return SOURCE_LANGUAGE;
    try {
        const user = await require('./auth').fetchNextcloudUser(uid);
        return normaliseLanguage(user.language);
    } catch (err) {
        log.debug(`[l10n] language lookup failed, answering in English: ${errMessage(err)}`);
        return SOURCE_LANGUAGE;
    }
}

module.exports = { t, userLanguage, normaliseLanguage, dictionary, SOURCE_LANGUAGE };
