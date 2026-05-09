# Security Policy

## Reporting a vulnerability

Please report security issues privately to **tomkooy@beeflow.nl**. Do not
open a public GitHub issue.

We aim to acknowledge reports within 2 business days, share a remediation
plan within 7 days, and ship a fix within 30 days for high-severity issues.

## Scope

This repository contains the Bee Flow Nextcloud connector — the ExApp
that bridges a Nextcloud installation to the hosted (or self-hosted)
Bee Flow service. In-scope concerns include:

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
