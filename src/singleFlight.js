/**
 * Coalesce concurrent calls of an async task.
 *
 * A call while a run is in flight joins that run when `stamp()` is unchanged
 * since the run started. When the stamp moved on (a new tenant key, a new
 * callback URI), the in-flight run works on stale input, so one more run is
 * queued behind it; further calls share that queued run.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {() => unknown} [stamp]
 * @returns {() => Promise<T>}
 */
function singleFlight(task, stamp = () => null) {
    /** @type {Promise<T> | null} */
    let running = null;
    /** @type {unknown} */
    let runningStamp;
    /** @type {Promise<T> | null} */
    let queued = null;

    /** @returns {Promise<T>} */
    function start() {
        runningStamp = stamp();
        running = Promise.resolve().then(task).finally(() => { running = null; });
        return running;
    }

    /** @returns {Promise<T>} */
    function run() {
        if (!running) return start();
        if (stamp() === runningStamp) return running;
        if (!queued) {
            queued = running.catch(() => undefined).then(() => {
                queued = null;
                return run();
            });
        }
        return queued;
    }
    return run;
}

module.exports = { singleFlight };
