'use strict';
/**
 * Narrowing helpers for the http objects the proxies get from http-proxy-middleware.
 */

/**
 * http-proxy-middleware hands its error hook a ServerResponse, or a Socket for a websocket
 * upgrade. These proxies run behind express, so a response here is express's Response; a
 * socket (or anything else) is not and gets no JSON answer.
 * @param {unknown} res
 * @returns {res is import('express').Response}
 */
function isExpressResponse(res) {
    return typeof res === 'object' && res !== null
        && 'headersSent' in res && 'status' in res && typeof res.status === 'function';
}

module.exports = { isExpressResponse };
