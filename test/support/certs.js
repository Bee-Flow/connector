// Throw-away certificates for the TLS tests, made with the openssl CLI.
//
//   const certs = certFactory(workDir);
//   const ca = certs.make({ isCa: true, cn: 'Company CA' });
//   const leaf = certs.make({ ca });        // for localhost / 127.0.0.1
//   const lonely = certs.make();            // self-signed leaf

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NEW_KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
const SAN = 'subjectAltName=IP:127.0.0.1,DNS:localhost';

/** @param {string} work  an existing directory the files are written to */
function certFactory(work) {
    let n = 0;
    return {
        /** @param {{ ca?: { certPath: string, keyPath: string } | null, isCa?: boolean, cn?: string }} [opts] */
        make({ ca = null, isCa = false, cn = 'localhost' } = {}) {
            const id = ++n;
            const key = path.join(work, `k${id}.pem`);
            const cert = path.join(work, `c${id}.pem`);
            if (!ca) {
                const ext = isCa
                    ? ['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']
                    : ['-addext', SAN];
                execFileSync('openssl', ['req', '-x509', ...NEW_KEY, '-days', '1', '-subj', `/CN=${cn}`, ...ext,
                    '-keyout', key, '-out', cert], { stdio: 'ignore' });
            } else {
                const csr = path.join(work, `r${id}.csr`);
                const extFile = path.join(work, `e${id}.cnf`);
                fs.writeFileSync(extFile, `${SAN}\n`);
                execFileSync('openssl', ['req', '-new', ...NEW_KEY, '-subj', `/CN=${cn}`, '-keyout', key, '-out', csr],
                    { stdio: 'ignore' });
                execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca.certPath, '-CAkey', ca.keyPath,
                    '-CAcreateserial', '-days', '1', '-extfile', extFile, '-out', cert], { stdio: 'ignore' });
            }
            return {
                key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8'), keyPath: key, certPath: cert,
            };
        },
    };
}

module.exports = { certFactory };
