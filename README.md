# Bee Flow Nextcloud connector

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

ExApp / AppAPI connector that lets a Nextcloud instance host the Bee Flow workspace UI and forward authenticated requests to a Bee Flow server: Bee Flow Cloud or your own.

App ID: `bee_flow` · Compatible with Nextcloud 33–35 · Requires the AppAPI shipped with those releases, with a Docker deploy daemon (HaRP recommended). Not installable on managed or shared hosting without Docker.

**The connector has no Bee Flow server until an administrator chooses one.** After installing, a Nextcloud administrator opens Bee Flow and chooses where it runs. Until then nothing is sent to any Bee Flow server.

> AppAPI stopped publishing standalone versions after 3.2.0 and now versions in
> lockstep with the Nextcloud major (32.0.0, 33.0.0, …), so "AppAPI ≥ 3.2" no
> longer reads as a version bound — state the Nextcloud range instead. Nextcloud
> 31 reached end-of-life in February 2026.

## Architecture

```
Your Nextcloud  ──► bee-flow-connector (this) ──► the Bee Flow server
   (AppAPI signed                JWT (5 min,          an administrator chose
    request, OCS user           HS256, signed         (Bee Flow Cloud or
    lookup)                     with tenant key)       your own)
```

The connector is the only thing the Nextcloud App Store sees. The Bee Flow server is reached only via the JWT-bearer proxy, and only once it has been chosen.

## Local development

The fastest way to run this connector against a local Nextcloud — **without** publishing anything to the App Store — is the bundled sandbox script:

```bash
./scripts/local-sandbox.sh up
```

This builds the connector image, runs Nextcloud on `:8080` (admin/admin), installs AppAPI, registers a `manual-install` deployment daemon, and side-loads this connector. End state: open <http://localhost:8080>, click the bee in the top bar.

### HaRP mode (streams arrive live)

```bash
HARP=1 ./scripts/local-sandbox.sh up      # or: ./scripts/local-sandbox.sh up --harp
```

The default sandbox reaches the connector through Nextcloud's AppAPI PHP proxy, which buffers every response until the ExApp is done (Nextcloud builds Guzzle with the synchronous `CurlHandler`), so SSE streams — chat, the builder — land in one burst at the end. `HARP=1` reproduces the production shape instead: a [HaRP](#deployment-modes-harp-vs-docker-socket-proxy) container (`bee-flow-harp`) plus an nginx front door (`bee-flow-nc-front`) on `:8080` that sends `/exapps/` to HaRP and everything else to Nextcloud, while the connector dials out over the FRP tunnel and publishes no port. What changes: Nextcloud stops publishing the host port (an existing sandbox is migrated onto the same volume), a `bee_flow_harp` daemon replaces `manual_dev`, the shared key lives in `.sandbox/harp.key` (gitignored), and the tenant key is cached in the `bee-flow-connector-data` volume so recreates don't re-provision an org. A plain `up` switches back. `clean` keeps the two volumes unless `FULL_CLEAN=1`. Both modes now also run a `bee-flow-nc-worker` sidecar (webhook + cron jobs) and set `allow_local_remote_servers`, without which Nextcloud refuses to call the connector at all ("violates local access rules").

## Choosing Bee Flow Cloud or a self-hosted server

A new install is connected to nothing. The first time a Nextcloud administrator opens **Bee Flow** from the top bar, the connector's own setup page asks where Bee Flow runs. Two cards, nothing preselected: **Bee Flow Cloud** or **Self-hosted server** (your own URL, optionally a pairing code). Everybody else reads "Bee Flow is not set up yet" until then.

Before **Connect** the page shows what connecting sends and to which host: the names and e-mail addresses of the Nextcloud's administrators, its address, instance id and version. On a first choice the connector asks the address for `/api/health` first; when no Bee Flow server answers, nothing is saved and nothing is sent.

After the choice, an administrator reaches the page at:

- HaRP: `https://<your-nc>/exapps/bee_flow/setup`
- Other deploy daemons: `https://<your-nc>/index.php/apps/app_api/proxy/bee_flow/setup`

To fix the server at install time instead, give it as an install-time value:

```bash
sudo -u www-data php occ app_api:app:register bee_flow <daemon> \
    --env BEEFLOW_API_BASE_URL=<your Bee Flow server URL>     # or the word: cloud
```

Left empty, the administrator chooses. An install-time value takes precedence over the setup page and cannot be changed from inside Nextcloud — useful for IaC / GitOps lockdown. For Bee Flow Cloud use the word `cloud`; the address `https://server.beeflow.nl` in that variable is not a choice by itself. To change the value, register the app again (`occ app_api:app:unregister bee_flow` without `--rm-data` keeps the data). An install that is already connected keeps its server across updates. See [the docs](https://docs.beeflow.ai/connector/setup-picker) for the full flow.

Subcommands:

```bash
./scripts/local-sandbox.sh status   # show container state
./scripts/local-sandbox.sh logs     # tail logs
./scripts/local-sandbox.sh down     # stop containers (keep data)
./scripts/local-sandbox.sh clean    # nuke containers + image
FORCE=1 ./scripts/local-sandbox.sh up   # force re-register from info.xml
HARP=1 ./scripts/local-sandbox.sh up    # HaRP mode — see above
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

`APP_SECRET`, `NEXTCLOUD_URL`, `APP_ID`, `APP_PORT`, etc. are normally injected by AppAPI. For local dev, set them by hand. `BEEFLOW_TENANT_KEY` is optional: without it the connector gets its key when an administrator connects it on the setup page; with it, it is an install-time value (`occ app_api:app:register bee_flow <daemon> --env BEEFLOW_TENANT_KEY=<key>`).

## Deployment modes: HaRP vs Docker Socket Proxy

The connector image supports **both** AppAPI deployment modes from one build;
`HP_SHARED_KEY` (injected by AppAPI) is what selects between them at runtime.

**HaRP** (HaProxy Reversed Proxy) is the mode to prefer: AppAPI deprecated the
Docker Socket Proxy daemon and **scheduled its removal for Nextcloud 35** (the
AppAPI of Nextcloud 35 still accepts it). Under HaRP the container dials out over an FRP tunnel (no
inbound port), binds a unix socket instead of TCP, and — the part that matters
operationally — clients reach it on `/exapps/<app_id>/`, **bypassing Nextcloud's
PHP entirely**.

That bypass is not a micro-optimisation. AppAPI's PHP proxy keeps each request
open without a timeout (`RequestOptions::TIMEOUT => 0`) until the ExApp is done
and only then passes the body on. So on a Docker Socket Proxy or
`manual-install` daemon two things hold at once: a streamed answer (chat, the
builder) reaches the browser in one burst at the end, and **every open stream
occupies one PHP-FPM worker for its whole lifetime**. A few dozen concurrent
chats can exhaust the pool and take the entire Nextcloud instance down with
them — not just Bee Flow. WebSockets are not supported through the PHP proxy at
all. This is the reason to move such an install to HaRP.

A HaRP daemon that connects to ExApps directly, without the tunnel
(`harp_exapp_direct`, which Nextcloud All-in-One's `harp_aio` daemon uses),
passes no `HP_SHARED_KEY`. The connector then listens on TCP and is reached
through the PHP proxy, as on a Docker Socket Proxy daemon.

### Reverse-proxy settings HaRP needs

The reverse proxy in front of Nextcloud must send `/exapps/` to HaRP's ExApps
port (8780 by default); Nextcloud All-in-One does this by itself. The nginx
block the sandbox runs, an Apache example and a check are in
[Deploy daemon and reverse proxy](https://docs.beeflow.ai/connector/deploy-daemon).

HaRP holds long-lived streams open (`HP_TIMEOUT_SERVER`, default 1800s). Whatever
sits in front of Nextcloud must not cut them shorter:

| Proxy | Setting |
|---|---|
| nginx | `proxy_read_timeout 1800s;` |
| Caddy | `read_timeout 1800s` |
| Traefik | `responseHeaderTimeout: 1800s` |
| Apache | `ProxyTimeout 1800` |
| Cloudflare (proxy or Tunnel) | Route order, challenges, upload size: see [Nextcloud behind Cloudflare](https://docs.beeflow.ai/connector/troubleshooting#cloudflare) |

### Two HaRP behaviours worth knowing

- **Temporary block.** HaRP drops every request from a client address while 10
  or more failures (`HP_BLACKLIST_COUNT`) of that address lie within 300 seconds
  (`HP_BLACKLIST_WINDOW`). Failures are the requests HaRP refuses itself (wrong
  shared key, unknown app, no matching route, access denied) and, only on
  routes that declare it in `info.xml`, the answers of the app with a listed
  status: for this connector `/hooks/` with 401 and 403. The `/nc/*` route
  declares none, so a rejected signature there does not count. The connector
  counts signature rejections itself and shows them in
  `GET /setup/diagnostics` (`callbackSignatures`). Behind a reverse proxy HaRP
  counts all visitors as one address unless `HP_TRUSTED_PROXY_IPS` names the
  proxy. Details:
  [HaRP's temporary block](https://docs.beeflow.ai/connector/deploy-daemon#harp-block).
- **Session caching.** `HP_SESSION_LIFETIME` (default 3s) caches the resolved
  Nextcloud session, so a just-changed permission can take a few seconds to be
  reflected.

### FRP certificate lifetime

The mutual-TLS certificates HaRP generates for the tunnel are valid for
`HP_FRP_CERT_VALIDITY_DAYS` (default 5000 ≈ 13 years) and are **not
auto-renewed**. Regenerating them requires removing and re-installing every
ExApp — a restart is not enough.

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
