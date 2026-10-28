/**
 * SIGTERM / SIGINT handling.
 *
 * A stop is NOT an uninstall. Every container stop sends SIGTERM to node
 * (PID 1 via `exec "$@"` in scripts/harp-start.sh): `docker restart`, a host
 * reboot, an ExApp update, an AppAPI daemon restart. The connector used to
 * unregister everything it had registered with Nextcloud here, and for the
 * Talk bot that is destructive: Talk deletes the bot from every conversation
 * when its row goes (BotListener::handleBotUninstallEvent), so after each
 * restart the bot had silently left all rooms until each moderator re-added
 * it. Webhook rows, task providers and file actions went too, losing the
 * events of the restart window.
 *
 * Every registration is idempotent and re-runs on boot, and AppAPI cleans up
 * after itself on a real uninstall (unregisterExAppTalkBots,
 * WebhookListenerMapper::deleteByAppId). So a stop only exits.
 */

const log = require('./log');

/**
 * @param {{ exit?: (code: number) => void }} [deps]
 * @returns {(signal: string) => void}
 */
function createShutdownHandler({ exit = (code) => process.exit(code) } = {}) {
    let shuttingDown = false;
    return (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`[BeeFlowConnector] ${signal} — exiting (Nextcloud registrations are kept)`);
        exit(0);
    };
}

module.exports = { createShutdownHandler };
