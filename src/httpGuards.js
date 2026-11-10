'use strict';
/**
 * Narrowing helpers for the http objects the proxies get from http-proxy-middleware, and the
 * answer to a request whose handler threw.
 */

const log = require('./log');
const { errMessage } = require('./errors');

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

/**
 * The last handler of the app: a request whose handler threw gets a plain 500 that says nothing
 * about the connector's files or code. The detail goes to the log.
 * @type {import('express').ErrorRequestHandler}
 */
function terminalErrorHandler(err, req, res, _next) {
    log.error(`[Server] ${req.method} ${req.path} failed: ${errMessage(err)}`);
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.status(500).json({ error: 'The Bee Flow connector could not handle this request. Its log has the detail.' });
}

module.exports = { isExpressResponse, terminalErrorHandler };
