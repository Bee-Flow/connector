# Bee Flow Nextcloud connector

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

ExApp / AppAPI connector that lets a Nextcloud instance host the Bee Flow workspace UI and forward authenticated requests to the Bee Flow SaaS.

App ID: `bee_flow` · Compatible with Nextcloud 31–34 · Requires AppAPI ≥ 3.2.

## Architecture

```
Customer Nextcloud  ──► bee-flow-connector (this) ──► server.beeflow.nl
   (AppAPI signed                JWT (5 min,
    request, OCS user           HS256, signed
    lookup)                     with tenant key)
```

The connector is the only thing the Nextcloud App Store sees. The hosted SaaS at `server.beeflow.nl` stays proprietary and is reached only via the JWT-bearer proxy.

## Local development

The fastest way to run this connector against a local Nextcloud — **without** publishing anything to the App Store — is the bundled sandbox script:

```bash
./scripts/local-sandbox.sh up
```

This builds the connector image, runs Nextcloud on `:8080` (admin/admin), installs AppAPI, registers a `manual-install` deployment daemon, and side-loads this connector. End state: open <http://localhost:8080>, click the bee in the top bar.

## Switching between Bee Flow Cloud and a self-hosted server

The connector ships with a small built-in picker page where an admin chooses where API traffic goes. Two big cards: **Bee Flow Cloud** (recommended) or **Self-hosted server** (paste your own URL, test it, save).

Reach the picker at:

- Embedded inside Nextcloud: `http://<your-nc>/index.php/apps/app_api/embedded/bee_flow/setup`
- Direct to the connector: `http://localhost:23000/setup` (host-only)

Set programmatically via `occ`:

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow \
    BEEFLOW_API_BASE_URL https://server.beeflow.nl     # or your self-hosted URL
```

The env-var path takes precedence over the picker — useful for IaC / GitOps lockdown. See [the docs](https://bee-flow.github.io/docs/connector/setup-picker/) for the full flow.

Subcommands:

```bash
./scripts/local-sandbox.sh status   # show container state
./scripts/local-sandbox.sh logs     # tail logs
./scripts/local-sandbox.sh down     # stop containers (keep data)
./scripts/local-sandbox.sh clean    # nuke containers + image
FORCE=1 ./scripts/local-sandbox.sh up   # force re-register from info.xml
```

Full walkthrough — including the manual `occ` commands and verification steps — at <https://bee-flow.github.io/docs/getting-started/local-development/>.

### Running the connector directly (without Nextcloud)

If you just want to iterate on the Express handlers without a Nextcloud in the loop:

```bash
cd nextcloud-connector
npm install
APP_SECRET=dev-secret \
NEXTCLOUD_URL=http://localhost:8080 \
BEEFLOW_TENANT_KEY=dev-tenant-key \
BEEFLOW_API_BASE_URL=http://localhost:3101 \
APP_PORT=9000 \
npm start
```

`APP_SECRET`, `NEXTCLOUD_URL`, `APP_ID`, `APP_PORT`, etc. are normally injected by AppAPI. For local dev, set them by hand. `BEEFLOW_TENANT_KEY` is configured per customer via `occ app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY <key>` after install.

## Building the container

```bash
docker build -t ghcr.io/bee-flow/connector:dev .
```

The Dockerfile clones [`Bee-Flow/hive`](https://github.com/Bee-Flow/hive) anonymously over HTTPS at build time and bakes the SPA into the image — no SSH key or GitHub token required. Pass `--build-arg HIVE_REF=v0.1.0` to pin a specific frontend tag.

## Tests

```bash
cd nextcloud-connector
npm install
npm test
```

## License

[AGPL-3.0-or-later](LICENSE).
