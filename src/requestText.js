'use strict';
/**
 * Questions about a request path or a Content-Type header, answered with plain
 * string comparisons: the time each takes grows with the length of the text
 * and with nothing else.
 */

const SETUP_PATH = '/setup';
const HTML_TYPE = 'text/html';

/**
 * Is this code unit a letter, a digit or an underscore (ASCII)?
 * @param {number} code
 */
function isWordCode(code) {
    return (code >= 48 && code <= 57) // 0-9
        || (code >= 65 && code <= 90) // A-Z
        || code === 95 // _
        || (code >= 97 && code <= 122); // a-z
}

/**
 * Is this path the connector's setup page or one of its routes: `/setup`
 * itself or anything below `/setup/`? `/setups` is not.
 * @param {string} urlPath  a path without its query
 */
function isConnectorSetupPath(urlPath) {
    return urlPath === SETUP_PATH || urlPath.startsWith(`${SETUP_PATH}/`);
}

/**
 * Does this Content-Type header name `text/html`, in any case, with or without
 * parameters? `text/html` and `text/html; charset=utf-8` do, `text/htmlx` and
 * `application/xhtml+xml` do not.
 * @param {string} contentType
 */
function isHtmlContentType(contentType) {
    if (contentType.slice(0, HTML_TYPE.length).toLowerCase() !== HTML_TYPE) return false;
    return contentType.length === HTML_TYPE.length || !isWordCode(contentType.charCodeAt(HTML_TYPE.length));
}

/**
 * Does this Content-Type header mention `javascript`, in any case and at any
 * place (`text/javascript`, `application/javascript; charset=utf-8`,
 * `application/x-javascript`)?
 * @param {string} contentType
 */
function isJavascriptContentType(contentType) {
    return contentType.toLowerCase().includes('javascript');
}

module.exports = { isConnectorSetupPath, isHtmlContentType, isJavascriptContentType };
