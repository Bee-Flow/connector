# Security Policy

## Reporting a vulnerability

Please report security issues privately to **tomkooy@beeflow.nl**. Do not
open a public GitHub issue.

We aim to acknowledge reports within 2 business days, share a remediation
plan within 7 days, and ship a fix within 30 days for high-severity issues.

## Nextcloud security guidelines

This connector is an ExApp — a Node process behind AppAPI's proxy, not a PHP
app — so the framework guarantees a PHP app inherits have to be rebuilt here.
Where each item of Nextcloud's developer security guidance
([prologue](https://docs.nextcloud.com/server/latest/developer_manual/prologue/security.html),
[digging deeper](https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/security.html))
lives in this codebase:

| Guideline | Where it is handled |
|---|---|
| SQL injection | Not applicable — the connector owns no database. State is a JSON file in `APP_PERSISTENT_STORAGE` (mode 0600). |
| XSS | The embedded app is React (auto-escaping). The one hand-written page, `src/setup.html`, escapes every interpolated value (`esc()`); prefer `showStatusText()` over `showStatus()` for new copy. |
| Clickjacking | `src/security.js` — `frame-ancestors` lists only this Nextcloud's own origins plus `BEEFLOW_TRUSTED_EMBED_ORIGINS`. A request's own `Origin`/`Referer` is never echoed into it. |
| Code execution / file inclusion | No `eval`, no `child_process`, no user input in a `require()`. Static files are served from the baked `public/` only. |
| Directory traversal | `src/ncProxy.js` — `isAllowedNcPath()` rejects `..` in any spelling before the three-prefix allow-list is applied. |
| Shell injection | No shell is invoked at runtime. |
| Authentication bypass / privilege escalation | `src/auth.js` verifies the AppAPI shared secret in constant time on every request before trusting the uid it carries. `src/setup.js` re-checks Nextcloud admin membership on every org-level action rather than relying on `info.xml` access levels alone. |
| Sensitive data exposure | `/heartbeat` is PUBLIC by necessity; it reports coarse state to anyone and the failure diagnosis (server URL, upstream error, remediation) only to a caller holding the shared secret. `/setup/diagnostics` is admin-only. |
| CSRF | `src/security.js` — AppAPI's proxy controller is `#[NoCSRFRequired]`, so the connector rejects any state-changing request the browser reports as `Sec-Fetch-Site: cross-site`. |
| Unvalidated redirects | The connector issues no redirects; the Files action returns a fixed handler id. |
| CORS | No `Access-Control-Allow-*` header is ever sent. |
| Rate limiting | `src/rateLimit.js` — per-uid budgets on the setup and verification routes (429 + `Retry-After`), and failure-only brute-force gates on the signature-authenticated routes (`/nc/*`, `/hooks/*`). |
| Remote host validation | `src/remoteHost.js` — every admin-supplied URL is checked for scheme, embedded credentials and link-local/cloud-metadata addresses before any connection. Loopback and RFC1918 stay allowed: self-hosting depends on them. |
| Trusted domain verification | `src/setup.js` — `pointsAtThisNextcloud()` compares the Nextcloud instance id before accepting an admin-supplied public Nextcloud URL. |

## Scope

This repository contains the Bee Flow Nextcloud connector — the ExApp
that bridges a Nextcloud installation to the hosted (or self-hosted)
Bee Flow service. In-scope concerns include:

- AppAPI shared-secret verification bypass (any path to a minted Bee Flow JWT
  without a matching `APP_SECRET`)
- AppAPI signature verification bypass on `/init`, `/heartbeat`, `/enabled`
- HMAC-signed `/nc/*` reverse-proxy authentication weakness
- AppAPI shared-secret leakage paths inside the container
- Bootstrap-flow vulnerabilities (instance-ID spoofing, tenant-key takeover)
- Container privilege escalation via mounted Docker / HaRP socket
- Improper handling of forwarded user impersonation via `EX-APP-USER-ID`

Out of scope:

- Issues in the embedded SPA (`Bee-Flow/hive`) — report there
- Issues in the Bee Flow server (`Bee-Flow/beeflow`) — report there
- Misconfigurations of self-hosted Nextcloud instances by their operators
- Theoretical vulnerabilities without a concrete exploitation path
- Findings on demo / staging instances that don't reproduce against the
  released image on `ghcr.io/bee-flow/connector`

## Disclosure

We follow a **coordinated disclosure** model: once a fix is shipped to
the latest release on the App Store, we publish a security advisory on
the [GitHub Security Advisories](https://github.com/Bee-Flow/connector/security/advisories)
page crediting the reporter (unless they ask for anonymity).

## Bounty

We don't currently run a paid bounty program. We do acknowledge reporters
publicly (with permission) and are happy to send Bee Flow swag for
valuable findings.

## Versions covered

Only the latest minor release on the `main` branch is supported. Older
versions may receive backported fixes for critical issues at our
discretion. The currently-released image tag is referenced in
`appinfo/info.xml` (`<docker-install><image-tag>`).

## Encryption

If you'd like to encrypt your report, please request our PGP key by mail
to **tomkooy@beeflow.nl** — we'll respond with the public key.
