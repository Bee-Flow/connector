# Changelog

All notable changes to the Bee Flow Nextcloud connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Nextcloud App Store reads the entry whose heading matches `<version>` in `appinfo/info.xml`.

## [0.1.35] - 2026-06-01

### Changed
- **Every Nextcloud admin is set up in Bee Flow at install, not just the one who installed.** On bootstrap the connector now discovers **all** members of Nextcloud's `admin` group that have an email and hands the full list to Bee Flow, which provisions each as an organisation admin. Previously only the first admin found was provisioned, so other admins could be blocked from the setup wizard. (Admins count as normal user seats; if the plan's seat cap is reached the extra admins are skipped and the install still succeeds. Older Bee Flow servers that don't yet understand the list fall back to the single primary admin — no breakage.)

## [0.1.34] - 2026-05-31

### Changed
- **Any Nextcloud admin can now complete the Bee Flow setup wizard**, not just the one admin discovered at install. Each per-user request now carries a signed `nc_admin` claim derived from the user's Nextcloud `admin`-group membership, so every NC admin is recognised as an organisation admin and can run onboarding. The claim is signed with the per-install tenant key, so a non-admin cannot forge it. (Pairs with the matching Bee Flow server change; no action needed on existing installs.)

## [0.1.33] - 2026-05-31

### Fixed
- **A fresh install now connects on the first try, even while Nextcloud's AppAPI auth is still warming up.** On a brand-new ExApp install, Nextcloud's AppAPI rejects the connector's shared-secret calls with `997 "AppAPI authentication failed"` for the first few seconds — its ExApp registration (and the secret it shares with the connector) hasn't propagated yet. The connector's install steps — admin-user lookup (which drives organisation provisioning), the top-menu / embedded-script / settings-form registrations, and init-status reporting — previously ran once and failed during that window, so the embedded app only came up if Nextcloud happened to re-run `/init` after auth had settled. When it didn't, the app stayed on "Sign in to continue" with every request 403'ing. These control-plane calls now **retry through the warm-up window** with capped exponential backoff (the 401/997 signature and transient network errors only), so a fresh install converges in a single pass. Real failures (404/409/500, a genuine 401 without the 997 marker, config errors) still fail fast, and per-request browser traffic is unaffected.

## [0.1.32] - 2026-05-31

### Fixed
- **First install now connects reliably** (was: "Sign in to continue" with every request 403'ing). On a fresh install the connector triggered its SaaS bootstrap from several places at once (container start, the `/init` lifecycle hook, the settings poll) before the tenant-key cache was written, firing multiple parallel "provision" requests. Against a multi-replica Bee Flow server each request could mint a different tenant key, so the connector cached a different key than the server stored and every per-user request was rejected with **403**. Bootstrap is now **single-flighted**: concurrent callers share one in-flight provision, so exactly one tenant key is minted and the connector and server always agree. An explicit admin reset (Setup → clear cache / repoint server / apply pairing code) still forces a fresh provision.

## [0.1.31] - 2026-05-31

### Fixed
- **Nextcloud WebDAV-based tools now work** (Files, Calendar/CalDAV, Contacts/CardDAV). These call back into Nextcloud through its AppAPI proxy, which forwards standard HTTP methods but rejects WebDAV verbs (PROPFIND/PROPPATCH/REPORT/MKCOL/MOVE/COPY) with **405** — so "List files" and similar failed with `Nextcloud PROPFIND failed (405)`. The server↔connector calls now tunnel those verbs over `POST` + `X-HTTP-Method-Override`, and the connector restores the real method (verified over the same HMAC) before calling Nextcloud, where WebDAV works. OCS-based tools were unaffected. Per-user impersonation is unchanged: each request still acts only as the signed-in Nextcloud user.

### Added
- **Clear organisation cache & re-bootstrap** action on the connector Setup page (admin-only). Drops the cached tenant key and re-bootstraps — the recovery path when this Nextcloud is bound to a Bee Flow organisation that was deleted/recreated server-side (symptom: the app loads but every request 401s). Re-binds to the existing org if present, otherwise provisions a fresh one; rolls back automatically on failure.

### Security
- The connector's admin Setup actions (clear-cache, rotate tenant key, apply pairing code, repoint server, diagnose) are now explicitly **ADMIN-gated** in the ExApp manifest instead of falling through to the USER-level catch-all — a non-admin can no longer trigger org-wide resets. The email-verification endpoints stay USER-level (gated by the one-time emailed code, before a tenant key exists).
- The connector now strips its internal routing headers (`X-Beeflow-NC-Uid`, `X-HTTP-Method-Override`) from requests before they reach Nextcloud.

## [0.1.30] - 2026-05-30

### Fixed
- The connector now installs and shows its top-bar icon on Nextcloud instances served with a **self-signed or internal-CA TLS certificate** (common on local / on-prem setups, e.g. Nextcloud All-in-One behind a `tls internal` reverse proxy or a `*.nip.io` test domain). Previously every connector→Nextcloud call failed certificate verification, so bootstrap never completed and the top-bar entry never registered. On first start the connector now does a strict TLS handshake to Nextcloud and, **only when that certificate does not already verify**, relaxes verification **for the Nextcloud origin alone** (via an origin-scoped HTTP dispatcher). Valid public / Let's Encrypt certificates are untouched, and the Bee Flow server channel — and every other TLS peer — stays fully verified (a public self-signed certificate still correctly fails). A HaRP/OS-mounted Nextcloud CA, when present and valid, is pinned instead of relaxing. Runs in all deploy modes (manual-install, HaRP FRP-tunnel, HaRP direct).

### Added
- `BEEFLOW_NC_CA_CERT` (optional, advanced) — paste your Nextcloud's PEM CA/root to pin an explicit trust anchor (verification stays on) instead of relying on automatic first-start trust.
- `BEEFLOW_NC_TLS_PIN` (optional, advanced, default `auto`) — set to `off` to disable automatic trust of a self-signed/internal Nextcloud certificate in security-strict environments (then only a valid certificate or `BEEFLOW_NC_CA_CERT` is accepted).
- `/setup` diagnostics now report the Nextcloud TLS posture (`ncTls.mode`) and, on a self-signed/internal-CA Nextcloud, a warning that on an **AIO + HaRP** deployment the embedded app stays blank until HaRP and Nextcloud's own PHP also trust the certificate (the connector can only fix its own connector→Nextcloud hop).
- `scripts/aio-trust-local-cert.sh` — local-testing helper that makes a Nextcloud All-in-One trust a self-signed/internal-CA certificate (adds the CA to the Nextcloud container and recreates the read-only HaRP container with `SSL_CERT_FILE`), so ExApps load their embedded UI on a local AIO+HaRP box. Not needed in production with a valid certificate.

## [0.1.29] - 2026-05-30

### Changed
- Removed the "Public beta — testing in progress" banner from the App Store description.

## [0.1.28] - 2026-05-30

### Changed
- Clearer **Advanced deploy options** help text in the Nextcloud App Store so admins understand the choice before installing: the default "Bee Flow server" is **Bee Flow Cloud** (`https://server.beeflow.nl`) and installing with it **creates a new organisation hosted by Bee Flow B.V. (EU)**; to keep data on your own infrastructure, point it at a self-hosted server (Community tier is free). The tenant-key text now spells out that "auto" creates a new organisation at whichever server is configured.

## [0.1.27] - 2026-05-29

### Changed
- Default **Bee Flow Cloud** endpoint is now the production service `https://server.beeflow.nl` (was the development server `https://server.dev.beeflow.nl`). This affects the App Store env-var default (`BEEFLOW_API_BASE_URL`), the runtime fallback, the "Bee Flow Cloud" choice in the Nextcloud admin settings picker, and the `/setup` page. Installs that pinned `BEEFLOW_API_BASE_URL` or chose a self-hosted server are unaffected.

## [0.1.26] - 2026-05-29

### Fixed
- The connector now runs correctly behind a **HaRP** deploy daemon (Nextcloud 32+). HaRP routes browser requests straight to the connector instead of tunnelling every call through Nextcloud's PHP process, which removes a source of intermittent dropped or stalled API calls: with the legacy daemon a long-lived chat stream plus the burst of requests the app makes on load could exhaust Nextcloud's PHP-FPM worker pool, so some calls would time out at random even though the connector and server were healthy.
- Docker health check now probes the right endpoint in HaRP mode (the connector listens on a Unix socket there, not a TCP port), so HaRP-deployed containers no longer report falsely unhealthy.

### Changed
- The bundled FRP client is now pinned to the version HaRP expects (0.61.1) rather than tracking the distribution package, avoiding silent tunnel-handshake failures from a client/server version mismatch.
- The Server-Sent-Events streaming workaround (connection-close framing) now only applies on the legacy manual / Docker-Socket-Proxy daemon, where Nextcloud's PHP proxy mangles chunked encoding. Under HaRP, streams use normal keep-alive chunked delivery.
- The legacy `manual-install` / Docker-Socket-Proxy daemon remains fully supported on Nextcloud 31; HaRP is recommended for Nextcloud 32+.

## [0.1.25] - 2026-05-29

### Changed
- Private-cloud deployments no longer show the "Pair a new Nextcloud" pairing-code panel (Settings → Organisation → Nextcloud Sync) — in those deployments pairing is managed by the provider. Generating a pairing code is also refused server-side in private-cloud mode.

## [0.1.24] - 2026-05-29

### Changed
- Default Bee Flow Cloud endpoint moved to `https://server.dev.beeflow.nl` (from `server.dev.beeflow.ai`) — affects the App Store env-var default (`BEEFLOW_API_BASE_URL`), the runtime fallback and the "Bee Flow Cloud" picker choice.

### Fixed
- Embedded admin view: Settings → Organisation → Users now reflects the server's authoritative organisation membership, fixing cases where an organisation admin saw an incomplete member list.

## [0.1.23] - 2026-05-29

### Fixed
- The verification code is now emailed to the admin who actually opens Bee Flow to do the setup — not the first admin account found on the Nextcloud server. Whoever completes verification becomes the organisation's Bee Flow admin. The code is only sent after re-checking that the signed-in admin belongs to the organisation being linked.

### Changed
- Onboarding wizard: removed the "Choose your deployment" step (Cloud vs self-hosted is set once by the Nextcloud admin in the connector's setup page, not per organisation), and the subscription step can now be skipped when no paid plans are configured, so setup never gets stuck.
- A plan flagged "Default plan for Nextcloud" is now applied as the organisation's active subscription on connect (previously it only adjusted enabled features) — set it on a free plan to give every Nextcloud-connected organisation a free default.

## [0.1.22] - 2026-05-28

### Added
- Pairing with an existing Bee Flow organisation now completes entirely inside Nextcloud. When the Nextcloud admin's email domain matches an existing organisation, Bee Flow emails a 6-digit verification code that the admin enters in the embedded app to confirm the link — no external Bee Flow login or separate web page. Installs whose admin-email domain doesn't match any organisation continue to auto-create a fresh organisation with no prompt. The code is single-use, time-limited and attempt-capped; free webmail domains (gmail.com, outlook.com, …) never auto-match an unrelated organisation.

## [0.1.21] - 2026-05-28

### Fixed
- Auto-pairing no longer creates an unusable, orphaned Bee Flow organisation when the Nextcloud admin account has no email address. The connector now requires a real admin email (so the install links to the correct Bee Flow account) and, if none is set, stops with a clear, actionable message instead of provisioning a broken org. To attach a Nextcloud to an existing Bee Flow organisation, use a pairing code.

## [0.1.20] - 2026-05-28

### Changed
- Build pipeline only (no functional change to the app): the image is now built natively per architecture (no QEMU emulation) with per-platform layer caching, and the bundled frontend is pinned to an exact commit per release for reproducible builds.

## [0.1.19] - 2026-05-28

### Changed
- Default Bee Flow API endpoint repointed from `server.beeflow.nl` to the dev environment `https://server.dev.beeflow.ai`. Affects the App Store env-var default (`BEEFLOW_API_BASE_URL`), the runtime fallback and the "Bee Flow Cloud" picker choice.

## [0.1.18] - 2026-05-27

### Added
- Setup page now has a **Bind to existing organisation** card that accepts a pairing code (`XXXX-XXXX`) generated in the Bee Flow admin panel. Admins can re-point a fresh install at an existing Bee Flow organisation in two clicks instead of SSH-ing to the NC host to set `BEEFLOW_PAIRING_CODE` via `occ app_api:app:setenv` + container restart. The previous tenant key is restored automatically if the code is expired or already redeemed.

### Changed
- App Store listing URLs migrated from the `app.beeflow.nl` subdomain to the apex domain `beeflow.nl` (privacy policy, pricing, homepage, website, author homepage) so admins land directly on the marketing site instead of the auth-gated app shell.

## [0.1.17] - 2026-05-27

### Changed
- Auth model simplified to a single per-install secret. The connector no longer re-verifies the `APP_SECRET` envelope on inbound requests — AppAPI's signed proxy is already the authentication boundary, and the redundant check was the source of `Invalid AppAPI shared secret` 401s whenever NC's stored secret drifted from the container env (common after re-registration or container restarts during install). The tenant key minted at first bootstrap by the SaaS remains the single load-bearing secret end-to-end: JWT signing for SaaS-bound traffic and HMAC verification of SaaS → connector callbacks are unchanged.

### Added
- Setup page exposes a **Rotate tenant key** button that drops the cached key and asks the SaaS to mint a fresh one bound to the same organisation. The previous key is restored automatically if the rotation fails. Use it for routine credential hygiene or after a suspected key leak.

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
