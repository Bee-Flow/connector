# Changelog

All notable changes to the Bee Flow Nextcloud connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Nextcloud App Store reads the entry whose heading matches `<version>` in `appinfo/info.xml`.

## [0.1.16] - 2026-05-27

### Changed
- Move the "Sustainable Use Licence" link from `app.beeflow.nl/license` to `docs.beeflow.ai/licensing` (license terms belong on the docs site, not the app surface) and hyperlink "paid tiers" to `docs.beeflow.ai/licensing/tiers` so admins reading the listing can land directly on the tier comparison.

## [0.1.15] - 2026-05-27

### Changed
- Re-add `BEEFLOW_NC_PUBLIC_URL` and `BEEFLOW_PAIRING_CODE` to the AppAPI env-vars block, **without** the empty `<default/>` tags that triggered the v0.1.11–v0.1.13 apps.nextcloud.com 500. Per the XSD `<default>` is optional, and omitting it is the correct shape for an env-var with no real default value.

## [0.1.14] - 2026-05-27

### Changed
- App Store metadata: temporarily removed `BEEFLOW_NC_PUBLIC_URL` and `BEEFLOW_PAIRING_CODE` from the `environment-variables` block in info.xml to isolate the cause of the persistent apps.nextcloud.com HTTP 500 on release submission (v0.1.10 with these absent registered fine; v0.1.11 onwards with them present consistently 500'd). The connector itself still reads these env vars at runtime — admins who need them can set them via the AppAPI deploy daemon's container env until they're re-added to the manifest.

## [0.1.13] - 2026-05-26

### Changed
- Release workflow: capped the apps.nextcloud.com registration retry budget at 2 attempts (was 5) so a sustained outage at apps.nextcloud.com no longer holds a runner for ~7 minutes per release.

## [0.1.12] - 2026-05-26

### Changed
- App Store listing URLs corrected: homepage, website, pricing link, install guide, Sustainable Use Licence and privacy-policy links all point at the right surface now (`app.beeflow.nl` for the app pages, `docs.beeflow.ai` for documentation).

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
