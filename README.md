# Bee Flow Nextcloud connector

ExApp / AppAPI connector that lets a Nextcloud instance host the Bee Flow workspace UI and forward authenticated requests to the Bee Flow SaaS.

## Status

**Pre-release scaffold.** Phase 0 gates (legal review, trademark check, publisher account, data-flow disclosure copy) are still open — see `plan/make-a-plan-to-reactive-spark.md` in the parent repo for the full plan.

## Architecture

```
Customer Nextcloud  ──► bee-flow-connector (this) ──► api.beeflow.ai
   (AppAPI signed                JWT (5 min,
    request, OCS user           HS256, signed
    lookup)                     with tenant key)
```

The connector is the only thing the Nextcloud App Store sees. The hosted SaaS at `api.beeflow.ai` stays proprietary and is reached only via the JWT-bearer proxy.

## Local development

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

From the repo root (so the SPA build context is reachable):

```bash
docker build -f nextcloud-connector/Dockerfile -t ghcr.io/beeflow-ai/bee-flow-connector:dev .
```

## Side-loading into a local Nextcloud

```bash
# 1. Start a Nextcloud sandbox with AppAPI installed
docker run -d --name nc-test -p 8080:80 nextcloud:31
docker exec -u www-data nc-test php occ app:install app_api

# 2. Register a docker-install daemon
docker exec -u www-data nc-test php occ app_api:daemon:register \
    local-docker docker-install local docker http://host.docker.internal:8080

# 3. Side-load this connector
docker exec -u www-data nc-test php occ app_api:app:register bee_flow \
    local-docker --info-xml /path/to/nextcloud-connector/appinfo/info.xml
```

## License

AGPL-3.0-or-later (pending Phase 0 legal review).
