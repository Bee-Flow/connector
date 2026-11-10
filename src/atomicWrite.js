'use strict';

/**
 * Atomic file write for the small state files on the persistent volume
 * (tenant-key.json, pending-bootstrap.json, ...). `fs.writeFile` opens with
 * O_TRUNC and writes afterwards, so a reader (or a crash) in between sees an
 * empty file. Here the content goes to a temp file next to the target and is
 * renamed over it, so the target is always the old or the new content.
 */

const fs = require('fs').promises;
const crypto = require('crypto');

/**
 * @param {string} file
 * @param {string} content
 * @param {number} [mode]
 * @returns {Promise<void>}
 */
async function writeFileAtomic(file, content, mode = 0o600) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        const handle = await fs.open(tmp, 'w', mode);
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(tmp, file);
    } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        throw e;
    }
}

module.exports = { writeFileAtomic };
