'use strict';
/**
 * Reading a caught value. `catch (e)` hands over `unknown` (anything can be thrown), so a
 * handler that wants `e.message` goes through here instead of asserting a type.
 */

/**
 * The message of whatever was thrown: an Error's own, a string as it is, or the text of any
 * other value. Objects that only carry a string `message` (a rejected plain object) count too.
 * @param {unknown} e
 * @returns {string}
 */
function errMessage(e) {
    if (e instanceof Error) return e.message;
    if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
    return String(e);
}

/**
 * The string `code` of a thrown value (`ECONNRESET`, `saas_unreachable`, ...), undefined when it has none.
 * @param {unknown} e
 * @returns {string | undefined}
 */
function errCode(e) {
    if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') return e.code;
    return undefined;
}

/**
 * `String(err.message || err || '')`: the text to match patterns against or to show, for a value
 * of unknown shape (an Error with an empty message falls back to the Error itself, "Error").
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
    const message = typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
    return String(message || err || '');
}

/**
 * A caught value as an Error, for handlers that read `.code`, `.status` or `.message` of it. An Error
 * is returned as it is; anything else is wrapped, keeping its text.
 * @param {unknown} e
 * @returns {Error}
 */
function asError(e) {
    return e instanceof Error ? e : new Error(errMessage(e));
}

module.exports = { errMessage, errCode, errText, asError };
