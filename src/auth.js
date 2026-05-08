/**
 * AppAPI authentication.
 *
 * Every request Nextcloud routes to this container carries headers that
 * prove (a) it really came from the customer's Nextcloud and (b) which user
 * is on the other end. We verify the signature, look up the user against
 * Nextcloud OCS, and mint a short-lived JWT the SaaS proxy can forward.
 *
 * Reference (header names + canonical-string format):
 *   https://github.com/nextcloud/app_api/blob/main/lib/AppAPIService.php
 *   https://docs.nextcloud.com/server/stable/developer_manual/exapp_development/tech_details/Authentication.html
 *
 * NOTE: AppAPI's signing scheme has shifted between AA versions. The
 * canonical-string layout below matches AA v3 (NC 30+). If a customer is
 * pinned to an older AppAPI we'll need to branch on `aa-version`.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

const HDR = {
    sig: 'aa-signature',
    sigTime: 'aa-signature-time',
    aaVersion: 'aa-version',
    requestId: 'aa-request-id',
    userId: 'ex-app-user-id',
};

function timingSafeEq(a, b) {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify the AppAPI HMAC signature on an incoming request.
 * Throws if invalid. Mutates nothing.
 */
function verifyAppApiSignature(req) {
    const sig = req.headers[HDR.sig];
    const sigTimeStr = req.headers[HDR.sigTime];
    if (!sig || !sigTimeStr) {
        const err = new Error('Missing AppAPI signature headers');
        err.status = 401;
        throw err;
    }

    const sigTime = parseInt(sigTimeStr, 10);
    if (!Number.isFinite(sigTime)) {
        const err = new Error('Malformed signature time');
        err.status = 401;
        throw err;
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - sigTime);
    if (skew > config.sigSkewSeconds) {
        const err = new Error(`Signature timestamp skew ${skew}s exceeds tolerance`);
        err.status = 401;
        throw err;
    }

    // Canonical string: METHOD\nPATH\nBODY_SHA256\nTIMESTAMP
    // (See AppAPIService::generateRequestSignature in the AppAPI source.)
    const bodyHash = crypto.createHash('sha256')
        .update(req.rawBody || '')
        .digest('hex');
    const canonical = [
        req.method.toUpperCase(),
        req.originalUrl || req.url,
        bodyHash,
        String(sigTime),
    ].join('\n');

    const expected = crypto.createHmac('sha256', config.appSecret)
        .update(canonical)
        .digest('base64');

    if (!timingSafeEq(sig, expected)) {
        const err = new Error('Invalid AppAPI signature');
        err.status = 401;
        throw err;
    }
}

/**
 * Look up a Nextcloud user via OCS. AppAPI service auth uses the same
 * APP_SECRET we already have — no additional credential.
 */
async function fetchNextcloudUser(uid) {
    const url = `${config.nextcloudUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const res = await fetch(url, {
        headers: {
            'OCS-APIRequest': 'true',
            'EX-APP-ID': config.appId,
            'EX-APP-VERSION': config.appVersion,
            'AUTHORIZATION-APP-API': Buffer.from(`${uid}:${config.appSecret}`).toString('base64'),
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new Error(`OCS user lookup failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    const data = body?.ocs?.data;
    if (!data) throw new Error('OCS user lookup returned no data');
    return {
        uid: data.id,
        email: data.email || null,
        displayName: data.displayname || data.display_name || data.id,
    };
}

/**
 * Mint a short-lived JWT for the SaaS proxy to use as the bearer.
 */
function mintSaasJwt(user) {
    return jwt.sign(
        {
            sub: user.uid,
            email: user.email,
            name: user.displayName,
        },
        config.tenantKey,
        {
            algorithm: 'HS256',
            issuer: 'nextcloud-connector',
            audience: 'beeflow.ai',
            expiresIn: config.jwtTtlSeconds,
        }
    );
}

/**
 * Express middleware: verifies AppAPI signature on every request, looks up
 * the user, attaches `req.beeflow = { user, jwt }`. Lifecycle endpoints
 * (/heartbeat, /init, /enabled) are exempt — AppAPI 5.x does not sign these
 * lifecycle probes, and they only run AppAPI-internal logic (health check,
 * status report) without touching user data.
 */
const LIFECYCLE_PATHS = new Set(['/heartbeat', '/init', '/enabled']);

function appApiAuthMiddleware(req, res, next) {
    if (LIFECYCLE_PATHS.has(req.path)) return next();
    // Public assets fetched server-to-server by NC (menu icon, embed JS) —
    // no user data, no API access. NC fetches these unsigned to inject into
    // its own chrome.
    if (req.path.startsWith('/img/') || req.path.startsWith('/js/')) return next();
    Promise.resolve()
        .then(() => verifyAppApiSignature(req))
        .then(() => {
            const uid = req.headers[HDR.userId];
            if (!uid) {
                const err = new Error('Missing EX-APP-USER-ID header');
                err.status = 401;
                throw err;
            }
            return fetchNextcloudUser(uid);
        })
        .then(user => {
            req.beeflow = { user, jwt: mintSaasJwt(user) };
            next();
        })
        .catch(err => {
            const status = err.status || 500;
            console.warn(`[Auth] ${status} ${req.method} ${req.url}: ${err.message}`);
            res.status(status).json({ error: err.message });
        });
}

module.exports = {
    appApiAuthMiddleware,
    verifyAppApiSignature,
    fetchNextcloudUser,
    mintSaasJwt,
    HDR,
};
