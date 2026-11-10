// The questions the connector asks about a request path and a Content-Type
// header, at their edges: what counts as the setup page, as an HTML answer and
// as a script.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConnectorSetupPath, isHtmlContentType, isJavascriptContentType } = require('../src/requestText');

/**
 * @param {(value: string) => boolean} ask
 * @param {string[]} yes
 * @param {string[]} no
 */
function decides(ask, yes, no) {
    for (const value of yes) assert.equal(ask(value), true, JSON.stringify(value));
    for (const value of no) assert.equal(ask(value), false, JSON.stringify(value));
}

test('the setup page is /setup and everything below /setup/', () => {
    decides(
        isConnectorSetupPath,
        ['/setup', '/setup/', '/setup/status', '/setup/a/b', '/setup//'],
        ['', '/', '/setups', '/setup.html', '/setup?x=1', '/setup\n', '/Setup', '/SETUP/status', 'setup', '/x/setup', '//setup', ' /setup'],
    );
});

test('an HTML answer is text/html in any case, alone or followed by something that is not part of the word', () => {
    decides(
        isHtmlContentType,
        [
            'text/html', 'text/html; charset=utf-8', 'text/html;charset=utf-8', 'TEXT/HTML', 'Text/Html; Charset=UTF-8',
            'text/html ', 'text/html,', 'text/html-x', 'text/html+xml', 'text/html\n', 'text/htmlé', 'text/htmlK',
        ],
        [
            '', 'text/htm', 'text/htmlx', 'text/html5', 'text/html_', 'text/htmlX', 'TEXT/HTMLS', ' text/html', 'text/ html',
            'application/xhtml+xml', 'text/plain', 'application/json; x=text/html', 'text/İhtml',
        ],
    );
});

test('a script answer mentions javascript in any case, anywhere in the header', () => {
    decides(
        isJavascriptContentType,
        [
            'javascript', 'text/javascript', 'application/javascript', 'application/javascript; charset=utf-8',
            'Application/JavaScript', 'TEXT/JAVASCRIPT', 'application/x-javascript', 'text/plain; x=javascript', 'xjavascriptx',
        ],
        [
            '', 'text/html', 'application/json', 'text/ecmascript', 'java script', 'text/javascrip', 'application/java-script',
            'javascrİpt', 'text/Kavascript',
        ],
    );
});

test('each answer is the one the pattern it stands for gives', () => {
    const samples = [
        '', '/', '/setup', '/setup/', '/setups', '/setup/x', '/setup\n', 'text/html', 'TEXT/HTML;', 'text/htmlx', 'text/html_',
        'text/htmlK', 'text/htmlſ', 'x text/html', 'application/JAVASCRIPT', 'javascrİpt', 'java', 'JavaScript\n',
    ];
    for (const value of samples) {
        assert.equal(isConnectorSetupPath(value), /^\/setup(\/|$)/.test(value), JSON.stringify(value));
        assert.equal(isHtmlContentType(value), /^text\/html\b/i.test(value), JSON.stringify(value));
        assert.equal(isJavascriptContentType(value), /javascript/i.test(value), JSON.stringify(value));
    }
});
