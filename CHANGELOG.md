# Changelog

All notable changes to the Bee Flow Nextcloud connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Nextcloud App Store reads the entry whose heading matches `<version>` in `appinfo/info.xml`.

## [0.1.3] - 2026-05-22

### Added
- Three real product screenshots (`01-chat.png`, `02-agents.png`, `03-agent-editor.png`) under `img/screenshots/`, wired into both the `<screenshot>` manifest entries and the markdown description so apps.nextcloud.com renders them inline.

## [0.1.2] - 2026-05-22

### Added
- First upload to apps.nextcloud.com on the **nightly** channel — visible only to admins who opt in to nightly/dev apps.

### Changed
- Screenshots temporarily removed from the manifest until the public listing is promoted from nightly to stable.

## [0.1.0] - 2026-05-09

### Added
- Initial public release.
- ExApp manifest, AppAPI HMAC signature verifier, AppAPI lifecycle endpoints (`/heartbeat`, `/init`, `/enabled`).
- Auto-bootstrap: first install provisions a Bee Flow organisation automatically — no manual tenant-key paste.
- Async `/init` per Nextcloud spec — install completes in well under a second.
- Embedded React SPA pulled at build time from the public [`Bee-Flow/hive`](https://github.com/Bee-Flow/hive) repository so reviewers can reproduce the image with `docker build .` and no credentials.
- Reverse proxy `/nc/*` from the SaaS back to the host Nextcloud, signed with a per-tenant HMAC key for SaaS → NC integration calls.
- Real-time user/group sync via AppAPI events_listener (graceful fallback when the listener API is unavailable on the running NC version).
- Periodic backstop sync covering missed webhooks (every 6h) — set up server-side, no connector-side configuration needed.
- 4-step onboarding wizard for the org admin on first open: user-sync mode, default user status, privacy shield categories, finish.
- Privacy Shield: PII detection (emails, IBANs, BSNs, names, …) before prompts reach the language model — local on-device by default.
- Multi-architecture image (linux/amd64 + linux/arm64).
- App Store categories: `ai`, `integration`, `workflow`, `office`.
- AppAPI scopes declared explicitly: `FILES`, `USER_INFO`, `GROUPS` required; `NOTIFICATIONS`, `CALENDAR`, `CONTACTS`, `MAIL`, `TALK`, `DAV` optional.

### Compatibility
- Nextcloud 31, 32, 33, 34.
- AppAPI 3.2+.

### Security
- Cosign-signed image with keyless OIDC attestation.
- SBOM (SPDX) attached to every GitHub release.
- Code-signed App Store tarball per Nextcloud's signing flow.
