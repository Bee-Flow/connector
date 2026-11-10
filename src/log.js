'use strict';
/**
 * The connector's one logger, same call shape as server/telemetry/log.js:
 * `log.warn('[Tag] what happened', detail, err)`.
 *
 * NODE_ENV=production or LOG_FORMAT=json writes ONE JSON object per line to
 * stdout, `{ ts, level, msg, err? }`. Otherwise (the image as shipped, tests,
 * development) the lines are plain text on the console: the method is looked up
 * at call time, so a spy on console.warn still sees the call.
 *
 * `log.ref(id)` turns a user id into a short digest for the message.
 *
 * Level, in both formats: LOG_LEVEL = debug | info | warn | error, default info.
 * No package dependency: the connector image stays small.
 */

const crypto = require('node:crypto');
const util = require('node:util');
const { wordFromEnv } = require('./envValues');

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */
/** @typedef {(...args: unknown[]) => void} LogFn */
/** @typedef {Record<LogLevel, LogFn> & { log: LogFn }} Logger */

/** @type {readonly LogLevel[]} */
const LEVELS = ['debug', 'info', 'warn', 'error'];
/** @type {Record<LogLevel, 'debug' | 'log' | 'warn' | 'error'>} */
const CONSOLE_METHOD = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

/** @param {NodeJS.ProcessEnv} [env] */
function isJsonMode(env = process.env) {
    if (env.LOG_FORMAT === 'json') return true;
    if (env.LOG_FORMAT === 'console') return false;
    return env.NODE_ENV === 'production';
}

/**
 * console.error('[Tag] failed:', err) -> msg '[Tag] failed: <message>' plus the first Error.
 * @param {unknown[]} args
 * @returns {{ msg: string, err: Error | null }}
 */
function splitArgs(args) {
    /** @type {Error | null} */
    let err = null;
    const printable = args.map((a) => {
        if (a instanceof Error) {
            if (!err) err = a;
            return a.message;
        }
        return a;
    });
    return { msg: util.format(...printable), err };
}

/**
 * @param {{ json?: boolean, level?: string, stream?: { write(chunk: string): unknown }, now?: () => Date }} [options]
 */
function createLogger({ json = false, level = 'info', stream = process.stdout, now = () => new Date() } = {}) {
    // An unknown level name counts as the lowest one (everything is written), as before.
    const min = Math.max(0, LEVELS.findIndex((l) => l === level));
    /** @param {LogLevel} lvl @returns {LogFn} */
    const sink = (lvl) => {
        const silent = LEVELS.indexOf(lvl) < min;
        if (!json) {
            // eslint-disable-next-line no-console -- the plain-text sink; looked up per call
            return (...args) => { if (!silent) console[CONSOLE_METHOD[lvl]](...args); };
        }
        return (...args) => {
            if (silent) return;
            const { msg, err } = splitArgs(args);
            /** @type {{ ts: string, level: LogLevel, msg: string, err?: { name: string, message: string, code?: string } }} */
            const line = { ts: now().toISOString(), level: lvl, msg };
            if (err) line.err = { name: err.name, message: err.message, code: err.code };
            stream.write(`${JSON.stringify(line)}\n`);
        };
    };
    const info = sink('info');
    /** @type {Logger} */
    const logger = { debug: sink('debug'), info, warn: sink('warn'), error: sink('error'), log: info };
    return logger;
}

/**
 * A Nextcloud user id is personal data: logs carry this short digest instead,
 * enough to tell two users apart in one log, not to read who it was.
 * @param {unknown} id
 */
function ref(id) {
    if (id === undefined || id === null || id === '') return '-';
    return `u_${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8)}`;
}

// LOG_LEVEL is an install-time option (info.xml): blank or any other word means info.
const log = createLogger({ json: isJsonMode(), level: wordFromEnv('LOG_LEVEL', LEVELS, 'info') });

module.exports = Object.assign(log, { createLogger, isJsonMode, ref });
