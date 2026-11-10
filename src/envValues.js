'use strict';
/**
 * Reading optional settings from the environment.
 *
 * AppAPI hands an install-time value to the container as text, exactly as an
 * administrator typed it in the deploy options, so every reader here falls
 * back to its default on a value it cannot use and keeps a number inside its
 * range. No dependency (log.js and config.js both load this).
 */

/**
 * A whole number from the environment. Unset, blank, negative or not a
 * number: the fallback. Otherwise the value, kept between min and max.
 * @param {string} name
 * @param {{ fallback: number, min: number, max: number }} range
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function intFromEnv(name, { fallback, min, max }, env = process.env) {
    const raw = String(env[name] ?? '').trim();
    if (raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * One of a fixed set of words from the environment, case-insensitive. Unset,
 * blank or any other word: the fallback.
 * @template {string} T
 * @param {string} name
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {T}
 */
function wordFromEnv(name, allowed, fallback, env = process.env) {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    const found = allowed.find((word) => word === raw);
    return found === undefined ? fallback : found;
}

module.exports = { intFromEnv, wordFromEnv };
