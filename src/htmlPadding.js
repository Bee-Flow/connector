'use strict';
/**
 * Room for the nonce Nextcloud writes into an HTML page.
 *
 * On a manual-install daemon every response passes through AppAPI's PHP proxy.
 * For a path that ends in `.html` it adds `nonce="…"` to every `<script` tag,
 * which makes the page longer, and passes the Content-Length it was given on
 * unchanged. A web server that does not compress the response then delivers
 * exactly that many bytes, so the page loses its last bytes: the end of the
 * last script, `</body>`, `</html>`.
 *
 * The connector therefore ends such a page with whitespace, counted in its
 * Content-Length, at least as long as the nonces that will be added. What is
 * cut off is then whitespace after `</html>`. Where nothing is added (HaRP, or
 * a compressed response) the browser gets a page with trailing whitespace.
 *
 * Only the `.html` paths are padded: `/index.html` is the path the Nextcloud
 * top bar frames on a manual-install daemon (server.js, /js/embed).
 */

// Per `<script` tag. The attribute is ` nonce="<value>"`; the value Nextcloud 35
// writes is 44 characters, and this leaves room for several times that.
const PAD_PER_SCRIPT_TAG = 256;
// A shell document is a few kilobytes; anything far beyond that is passed on
// as it is rather than held in memory.
const MAX_PADDED_BYTES = 2 * 1024 * 1024;

/**
 * Does AppAPI treat this path as HTML? Its own test: the extension is `html`.
 * @param {unknown} urlPath
 */
function isNoncePath(urlPath) {
    return String(urlPath || '').split('?')[0].endsWith('.html');
}

/**
 * The whitespace to append to this page.
 * @param {string | Buffer} html
 * @returns {string}
 */
function nonceRoom(html) {
    const text = typeof html === 'string' ? html : html.toString('latin1');
    let tags = 0;
    for (let at = text.indexOf('<script'); at !== -1; at = text.indexOf('<script', at + 1)) tags += 1;
    return tags ? `\n${' '.repeat(tags * PAD_PER_SCRIPT_TAG)}` : '';
}

/**
 * The page with room for its nonces.
 * @param {string} html
 * @returns {string}
 */
function withNonceRoom(html) {
    return html + nonceRoom(html);
}

module.exports = { isNoncePath, nonceRoom, withNonceRoom, PAD_PER_SCRIPT_TAG, MAX_PADDED_BYTES };
