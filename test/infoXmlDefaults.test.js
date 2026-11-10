// The install-time options of appinfo/info.xml never name a Bee Flow server.
//
// AppAPI stores the resolved value of every declared variable at install and
// passes it again on every update, so a <default> that holds an address would
// reach the connector as if somebody had typed it. The server is chosen by an
// administrator after installing; until then the connector has none.
//
// Both URL variables stay declared: AppAPI only passes on values of variables
// that the manifest declares, so an install that set one keeps it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INFO_XML = path.join(ROOT, 'appinfo', 'info.xml');

/** @returns {{ name: string, body: string, defaults: string[] }[]} */
function declaredVariables() {
    const xml = fs.readFileSync(INFO_XML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const block = xml.slice(xml.indexOf('<environment-variables>'), xml.indexOf('</environment-variables>'));
    return [...block.matchAll(/<variable>([\s\S]*?)<\/variable>/g)].map((m) => ({
        name: (m[1].match(/<name>([^<]*)<\/name>/) || [])[1],
        body: m[1],
        defaults: [...m[1].matchAll(/<default>([\s\S]*?)<\/default>/g)].map((d) => d[1].trim()),
    }));
}

test('no default holds a Bee Flow address', () => {
    const variables = declaredVariables();
    assert.ok(variables.length > 0, 'info.xml declares install-time variables');
    for (const v of variables) {
        for (const value of v.defaults) {
            assert.doesNotMatch(value, /beeflow/i, `${v.name}: the default names a Bee Flow host`);
            assert.doesNotMatch(value, /^[a-z][a-z0-9+.-]*:\/\//i, `${v.name}: the default is an address`);
        }
    }
});

test('the two URL variables are declared once, without a default', () => {
    const variables = declaredVariables();
    for (const name of ['BEEFLOW_API_BASE_URL', 'BEEFLOW_EMBED_BASE_URL']) {
        const found = variables.filter((v) => v.name === name);
        assert.equal(found.length, 1, `${name} is declared once`);
        assert.doesNotMatch(found[0].body, /<default/, `${name} has no <default>: left empty, the administrator chooses`);
        assert.match(found[0].body, /<display-name>[^<]+<\/display-name>/);
        assert.match(found[0].body, /<description>[^<]+<\/description>/);
    }
});

test('the description of the server variable names the word that selects Bee Flow Cloud', () => {
    const { CLOUD_KEYWORD } = require('../src/serverChoice');
    const server = declaredVariables().find((v) => v.name === 'BEEFLOW_API_BASE_URL');
    assert.ok(server);
    const description = (server.body.match(/<description>([^<]*)<\/description>/) || [])[1] || '';
    assert.match(description, new RegExp(`the word ${CLOUD_KEYWORD}\\b`));
});

test('the manifest and the package carry the same version', () => {
    const xml = fs.readFileSync(INFO_XML, 'utf8');
    const version = (xml.match(/<version>([^<]+)<\/version>/) || [])[1];
    assert.match(String(version), /^\d+\.\d+\.\d+$/);
    assert.equal(require('../package.json').version, version);
    const lock = require('../package-lock.json');
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
});
