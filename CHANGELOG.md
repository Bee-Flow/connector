# Changelog

All notable changes to the Bee Flow Nextcloud connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Nextcloud App Store reads the entry whose heading matches `<version>` in `appinfo/info.xml`.

## [0.1.11] - 2026-05-25

### Added
- New `BEEFLOW_PAIRING_CODE` AppAPI environment variable so a Nextcloud admin can bind their instance to an existing Bee Flow organisation on first boot instead of auto-creating a new one. The code is consumed once during bootstrap and ignored afterwards.
- `/setup/diagnostics` exposes tenant-key verification endpoints so admins can confirm the connector reached the SaaS with the correct organisation key without enabling debug logging.

## [0.1.10] - 2026-05-24

### Fixed
- `/setup` picker's "Save" button worked from the standalone URL but failed with `Save failed: Unexpected token '<'` when opened through NC's AppAPI proxy. The page used absolute paths like `/setup/test`, which the browser resolved against the NC origin instead of the proxy mount. Switched all fetches to a prefix derived from `window.location.pathname` so they go back through the signed proxy.
- All references to the legacy `beeflow.ai` domain renamed to `beeflow.nl` (the active domain); the stale `api.beeflow.ai` placeholder in the picker is now the verified `server.beeflow.nl` SaaS endpoint.

## [0.1.9] - 2026-05-23

### Changed
- Bootstrap surfaces a structured `code` + `remediation` field from the SaaS so the heartbeat and `/setup/diagnostics` endpoint give the admin an actionable message instead of a generic "fetch failed".
- New "Public Nextcloud URL" field in the `/setup` picker — admins behind NAT can point Bee Flow Cloud at a public tunnel/reverse-proxy URL without redeploying the connector.
- Embedded route now serves the SPA shell (with its error overlay) when bootstrap is still in flight, instead of a raw `User lookup failed` JSON page.

## [0.1.7] - 2026-05-22

### Changed
- First stable-channel release on apps.nextcloud.com so admins can install Bee Flow through the standard Apps → AI section instead of via manual `occ` commands.
- Added a prominent **Public beta** warning at the top of the listing description so admins understand the maturity level before installing.

## [0.1.6] - 2026-05-22

### Added
- Bee Flow brand logo (`img/bee-flow-logo.svg`) added as the first `<screenshot>` entry so apps.nextcloud.com uses it as the listing hero image and the apps-overview tile preview.

## [0.1.5] - 2026-05-22

### Changed
- Switched to the documented Nextcloud convention for screenshots: `<screenshot small-thumbnail="…">…</screenshot>` entries restored, inline `![]()` markdown images removed from the description. The App Store now renders the gallery in its dedicated section instead of as a heavy banner above the title.

## [0.1.4] - 2026-05-22

### Changed
- Removed the `<screenshot>` manifest entries: apps.nextcloud.com rendered them as a full-width carousel banner above the listing title, which crowded out the rest of the page. Same PNGs remain embedded inline in the markdown description so they sit next to the copy that explains them.

## [0.1.3] - 2026-05-22

### Added
- Three real product screenshots (`01-chat.png`, `02-agents.png`, `03-agent-editor.png`) under `img/screenshots/`, wired into both the `<screenshot>` manifest entries and the markdown description.

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
