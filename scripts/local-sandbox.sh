#!/usr/bin/env bash
# Local sandbox bringing up the full Bee Flow stack on one machine:
#   - Postgres 16              (data store for the Bee Flow server)
#   - RustFS                   (S3-compatible blob storage)
#   - Bee Flow server          (ghcr.io/bee-flow/beeflow:dev)
#   - Nextcloud                (Docker Hub) + bee-flow-nc-worker, a sidecar on
#                              the same volume that runs the webhook worker and
#                              cron.php (Nextcloud's event delivery to the
#                              connector depends on it)
#   - Bee Flow connector       (this repo's image)
#   - HaRP + nginx front door  (HARP=1 only — see "HaRP mode" below)
#
# All containers share the bee-flow-net Docker network and can resolve each
# other by container name. Set WITH_SERVER=0 to skip the Postgres + RustFS +
# server containers and point the connector at a remote server / SaaS instead
# (override API_BASE_URL).
#
# Subcommands: up | down | clean | logs | status | front
#   front — relaunch ONLY the nginx front door on :$NC_PORT (HaRP mode).
#           Use it when :$NC_PORT answers nothing while Nextcloud itself is
#           up: the front is stateless and resolves its upstreams once, at
#           start, so a recreated HaRP/Nextcloud (new IP) — or a front left
#           over from the bind-mounted-config era — strands it.
#   `up` accepts `--cloud` to point the connector at https://server.beeflow.nl
#   instead of the local SaaS, and auto-spawn a public tunnel (cloudflared by
#   default, ngrok if NGROK_AUTHTOKEN is set) so the cloud can callback-verify
#   your NC. One-command sandbox-against-cloud:
#     ./local-sandbox.sh --cloud
#   `up` accepts `--harp` (same as env HARP=1) for HaRP mode, see below.
#
# ─── HaRP mode (HARP=1) ──────────────────────────────────────────────────────
# Default mode registers the connector on a plain `manual-install` daemon
# (manual_dev): the browser talks to Nextcloud, and Nextcloud's AppAPI PHP
# proxy forwards /apps/app_api/proxy/<app>/* to the connector. That proxy
# BUFFERS every response until the ExApp has finished — Nextcloud builds Guzzle
# with the synchronous CurlHandler (lib/private/Http/Client/ClientService.php)
# — so SSE streams (chat, builder) arrive all at once at the end instead of
# token by token, and every open stream pins one PHP worker.
#
# HaRP (HaProxy Reversed Proxy) routes browser traffic for /exapps/<app>/ to
# the ExApp over HAProxy + an FRP tunnel, bypassing PHP entirely. The connector
# image is built for it (scripts/harp-start.sh keys on HP_SHARED_KEY: it binds
# a unix socket and dials frpc out to HaRP). Nextcloud itself recommends HaRP
# and removes the docker-socket-proxy daemon in NC 35, so this is also the
# shape customers run. `HARP=1 ./local-sandbox.sh up` reproduces it locally:
#
#   bee-flow-harp       HaRP in manual-install flavour: no docker socket; it
#                       mints its own FRP mTLS certs into the bee-flow-harp-certs
#                       volume. HP_TRUSTED_PROXY_IPS is set to the sandbox
#                       network's subnet: behind nginx every browser shares
#                       nginx's IP and HaRP's ban (10 bad responses / 300 s by
#                       default) would otherwise lock everyone out — it did.
#   bee-flow-nc-front   nginx on :$NC_PORT. /exapps/ → HaRP:8780 (unbuffered,
#                       1800 s timeouts), everything else → Nextcloud. Nextcloud
#                       itself no longer publishes a host port; a default-mode
#                       NC container is migrated onto the same /var/www/html
#                       volume and its old shell parked as bee-flow-nc-sandbox-old.
#   bee_flow_harp       manual-install daemon registered with --harp. Its
#                       nextcloud_url is the FRONT, not Nextcloud: AppAPI's
#                       ManualActions::resolveExAppUrl returns
#                       {nextcloud_url}/exapps/<app>, which is the URL
#                       Nextcloud's PHP uses for heartbeat/init/every app call.
#   connector           no published port; HP_SHARED_KEY / HP_FRP_ADDRESS /
#                       HP_FRP_PORT, the certs volume (ro) and a named
#                       bee-flow-connector-data volume so the cached tenant key
#                       survives recreates (default mode loses it and
#                       re-provisions an org every time).
#   .sandbox/harp.key   the HaRP shared key, generated once (mode 600,
#                       gitignored) so `up` is idempotent.
#
# Switching modes is safe in both directions: `up` detects a container /
# daemon / ExApp registration from the other mode and re-creates it.
#
# Env overrides:
#   NC_VERSION=35      NC_PORT=8080  APP_ID=bee_flow
#                      (info.xml supports 32–35. Pin to NC_VERSION=35.0.0 /
#                       34.0.4 / etc. for reproducibility. Note "stable" on
#                       Docker Hub still tracks 34.x, so it would pull the
#                       worker back a major against a 35 volume.)
#   IMAGE=bee-flow-connector:dev          # local build (default)
#   IMAGE=ghcr.io/bee-flow/connector:dev  # pull pre-built (no local build)
#   TENANT_KEY=auto                       # default: connector handshakes with
#                                          # the SaaS, which provisions an org
#                                          # and returns a real tenant key.
#                                          # A literal value here SKIPS that
#                                          # handshake — the SaaS won't have a
#                                          # matching `connector_tenant_key_*`
#                                          # row and every JWT will 401.
#   API_BASE_URL=                         # default: http://bee-flow-server:3001
#   EMBED_BASE_URL=                       # where the connector fetches the SPA
#                                          # shell (/embed/); unset = the connector
#                                          # default (https://beeflow.nl). Against a
#                                          # local stack: http://beeflow-agent-hub
#                                          override to e.g. https://server.beeflow.nl
#                                          to skip running the server locally
#   WITH_SERVER=1                          # 0 to skip Postgres + RustFS + server
#   SERVER_IMAGE=ghcr.io/bee-flow/beeflow:dev
#   SERVER_PORT=3001                       # host-published port for the server
#   PG_PASSWORD=beeflow-dev
#   RUSTFS_IMAGE=rustfs/rustfs:latest
#   RUSTFS_ACCESS_KEY=rustfsadmin
#   RUSTFS_SECRET_KEY=rustfsadmin
#
#   HARP=0                                 # 1 = HaRP mode (or pass --harp)
#   LAN_IP=                                # this box's LAN address, if another
#                                          # device should use the sandbox:
#                                          # added to trusted_domains, the
#                                          # server's CORS_ORIGIN and (HaRP) the
#                                          # connector's trusted embed origins
#   HARP_IMAGE=ghcr.io/nextcloud/nextcloud-appapi-harp:release
#   FRONT_IMAGE=nginx:alpine
#   HARP_TRUSTED_PROXY_IPS=                # default: the bee-flow-net subnet
#
#   WITH_OFFICE=0                          # 1 to bring back the Collabora CODE
#                                          # editor (the richdocuments app).
#                                          # Default is 0: this sandbox now uses
#                                          # Nextcloud Office (the eurooffice app
#                                          # + bee-flow-eurooffice document server
#                                          # on :9981), which handles docx/xlsx/
#                                          # pptx instead. Turning this back on
#                                          # re-enables richdocuments, and both
#                                          # apps then claim the same file types.
#                                          # One 467 MB image pull the first time.
#   OFFICE_IMAGE=collabora/code
#   OFFICE_PORT=9980                       # host port the browser loads the editor
#                                          # from (localhost only, or every interface
#                                          # when LAN_IP is set)
#
#   NGROK_AUTHTOKEN=...                    # if set, expose the local NC at a
#                                          # public https://*.ngrok-free.app URL
#                                          # so server.beeflow.nl's bootstrap
#                                          # callback can verify NC ownership.
#                                          # Required to use Cloud mode from
#                                          # this Docker sandbox; without it,
#                                          # only Self-hosted mode works.
#                                          # Get a free token (no card needed) at
#                                          # https://dashboard.ngrok.com/get-started/your-authtoken
#                                          # and run:
#                                          #   NGROK_AUTHTOKEN=... ./local-sandbox.sh

set -euo pipefail

NC_VERSION="${NC_VERSION:-35}"
NC_PORT="${NC_PORT:-8080}"
APP_ID="${APP_ID:-bee_flow}"
IMAGE="${IMAGE:-bee-flow-connector:dev}"
TENANT_KEY="${TENANT_KEY:-auto}"
# The SPA shell origin. Left empty the connector falls back to the public site,
# which is the one place a local sandbox must never fetch its UI from — the
# shell would then be a different build than the server it talks to.
EMBED_BASE_URL="${EMBED_BASE_URL:-}"

# HaRP mode (see header). `--harp` on the command line sets this too.
HARP="${HARP:-0}"
LAN_IP="${LAN_IP:-}"
HARP_IMAGE="${HARP_IMAGE:-ghcr.io/nextcloud/nextcloud-appapi-harp:release}"
FRONT_IMAGE="${FRONT_IMAGE:-nginx:alpine}"
HARP_TRUSTED_PROXY_IPS="${HARP_TRUSTED_PROXY_IPS:-}"

# Bee Flow server stack
WITH_SERVER="${WITH_SERVER:-1}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/bee-flow/beeflow:dev}"
SERVER_PORT="${SERVER_PORT:-3001}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_PASSWORD="${PG_PASSWORD:-beeflow-dev}"
RUSTFS_IMAGE="${RUSTFS_IMAGE:-rustfs/rustfs:latest}"

# Collabora CODE (the richdocuments app) next to NC on the shared network.
# Off by default: the sandbox now uses Nextcloud Office (eurooffice) against
# the bee-flow-eurooffice document server, so richdocuments would only fight
# it for docx/xlsx/pptx. Set WITH_OFFICE=1 to go back to Collabora.
WITH_OFFICE="${WITH_OFFICE:-0}"
OFFICE_IMAGE="${OFFICE_IMAGE:-collabora/code}"
OFFICE_PORT="${OFFICE_PORT:-9980}"
RUSTFS_ACCESS_KEY="${RUSTFS_ACCESS_KEY:-rustfsadmin}"
RUSTFS_SECRET_KEY="${RUSTFS_SECRET_KEY:-rustfsadmin}"

# Public-tunnel for Cloud mode (server.beeflow.nl needs to call NC back to
# verify ownership). Two implementations: cloudflared (default, no signup)
# and ngrok (opt-in via NGROK_AUTHTOKEN, named URL, slightly more reliable).
# A tunnel is started automatically whenever cmd_up runs in --cloud mode.
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
NGROK_IMAGE="${NGROK_IMAGE:-ngrok/ngrok:latest}"
NGROK_NAME="bee-flow-ngrok"
CFD_IMAGE="${CFD_IMAGE:-cloudflare/cloudflared:latest}"
CFD_NAME="bee-flow-cloudflared"

# --cloud flag — set later by cmd_up arg parsing. When true, the script:
#   1. skips the local Postgres+RustFS+server stack (WITH_SERVER=0)
#   2. points the connector at https://server.beeflow.nl
#   3. spawns a public tunnel for the bootstrap callback
CLOUD_MODE=0

# Container names — used as DNS aliases on the shared network.
NC_NAME="bee-flow-nc-sandbox"
CONN_NAME="bee-flow-connector-instance"
SRV_NAME="bee-flow-server"
PG_NAME="bee-flow-postgres"
RUSTFS_NAME="bee-flow-rustfs"
WORKER_NAME="bee-flow-nc-worker"      # webhook worker + cron.php on NC's volume
HARP_NAME="bee-flow-harp"             # HaRP mode only
FRONT_NAME="bee-flow-nc-front"        # HaRP mode only — nginx on :$NC_PORT
OFFICE_NAME="bee-flow-collabora"      # Collabora CODE (WITH_OFFICE=1)
HARP_PROXY_PORT=8780                  # HaRP: /exapps/ proxy (HAProxy)
HARP_FRP_PORT=8782                    # HaRP: frps, what the connector dials
HARP_CERTS_VOL="bee-flow-harp-certs"  # FRP mTLS certs HaRP mints on first start
CONN_DATA_VOL="bee-flow-connector-data"   # connector /data (cached tenant key)
MANUAL_DAEMON="manual_dev"
HARP_DAEMON="bee_flow_harp"
DAEMON="$MANUAL_DAEMON"               # cmd_up switches to $HARP_DAEMON in HaRP mode
NETWORK="bee-flow-net"     # shared bridge network — NC ↔ connector ↔ server
                           # all resolve each other by container name.

# Default the connector's SaaS target to the server we're starting locally.
# If WITH_SERVER=0, fall back to the public hosted SaaS (override per env).
if [ "$WITH_SERVER" = "1" ]; then
    API_BASE_URL="${API_BASE_URL:-http://$SRV_NAME:$SERVER_PORT}"
else
    API_BASE_URL="${API_BASE_URL:-https://server.beeflow.nl}"
fi

# Connector dir = parent of this script. Works in both layouts:
#   monorepo:   <monorepo>/nextcloud-connector/scripts/local-sandbox.sh
#   standalone: <connector-clone>/scripts/local-sandbox.sh
CONNECTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=/var/www/html/data/owncloud.db

# Sandbox state that must survive between runs but never enter git:
# the HaRP shared key and the generated nginx config. (.sandbox/ is gitignored.)
SANDBOX_DIR="$CONNECTOR_DIR/.sandbox"
HARP_KEY_FILE="$SANDBOX_DIR/harp.key"
FRONT_CONF="$SANDBOX_DIR/nc-front.conf"
HARP_KEY=""

# The version AppAPI registers comes from info.xml. The container reports its
# own in EX-APP-VERSION on every call and AppAPI writes a mismatch back to
# oc_ex_apps — so a hard-coded 0.1.0 quietly "downgraded" the registration.
APP_VERSION=$(sed -n 's:.*<version>\([^<]*\)</version>.*:\1:p' "$CONNECTOR_DIR/appinfo/info.xml" 2>/dev/null | head -1 || true)
APP_VERSION="${APP_VERSION:-0.1.0}"

g() { printf '\033[1;32m%s\033[0m\n' "$*"; }
b() { printf '\033[1;34m%s\033[0m\n' "$*"; }
r() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

nc_occ() { docker exec -u www-data "$NC_NAME" php occ "$@"; }
nc_sql() { docker exec "$NC_NAME" sqlite3 "$DB" "$1"; }

container_exists()  { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }
container_running() { docker ps    --format '{{.Names}}' | grep -qx "$1"; }
# Value of one env var baked into a container (empty if unset / no container).
container_env() {
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
        | sed -n "s/^$2=//p" | head -1 || true
}
# Name of the volume mounted at /var/www/html. The nextcloud image declares it
# as a VOLUME, so a plain `docker run` gets an anonymous one (64-hex name) —
# still a name we can hand to another container.
nc_html_volume() {
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/www/html"}}{{.Name}}{{end}}{{end}}' "$1" 2>/dev/null || true
}
# True when the container publishes any host port.
publishes_host_port() {
    [ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$1" 2>/dev/null || echo 0)" != "0" ]
}

# Add a host to trusted_domains without clobbering a slot someone else owns
# (0 = localhost from install, 1 = $NC_NAME, 2 = the tunnel host; a LAN IP or
# an older run may sit anywhere). Idempotent.
nc_trust_domain() {
    local host="$1" i
    if nc_occ config:system:get trusted_domains 2>/dev/null | grep -qxF "$host"; then
        return 0
    fi
    for i in $(seq 3 31); do
        if [ -z "$(nc_occ config:system:get trusted_domains "$i" 2>/dev/null || true)" ]; then
            b "[trust] adding $host to trusted_domains (slot $i)"
            nc_occ config:system:set trusted_domains "$i" --value="$host" >/dev/null
            return 0
        fi
    done
    r "no free trusted_domains slot for $host"
    return 1
}

# ─── stack helpers (Postgres + RustFS + server) ──────────────────────────────

start_postgres() {
    if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
        b "[Postgres] $PG_NAME already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
        b "[Postgres] starting existing $PG_NAME"
        docker start "$PG_NAME" >/dev/null
    else
        b "[Postgres] launching $PG_IMAGE"
        docker run -d --name "$PG_NAME" \
            --network "$NETWORK" \
            -e POSTGRES_DB=beeflow \
            -e POSTGRES_USER=beeflow \
            -e POSTGRES_PASSWORD="$PG_PASSWORD" \
            "$PG_IMAGE" >/dev/null
    fi
    b "[Postgres] waiting for ready"
    for _ in $(seq 1 30); do
        if docker exec "$PG_NAME" pg_isready -U beeflow >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    r "Postgres failed to become ready in 30s"
    return 1
}

start_rustfs() {
    if docker ps --format '{{.Names}}' | grep -qx "$RUSTFS_NAME"; then
        b "[RustFS] $RUSTFS_NAME already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$RUSTFS_NAME"; then
        b "[RustFS] starting existing $RUSTFS_NAME"
        docker start "$RUSTFS_NAME" >/dev/null
    else
        b "[RustFS] launching $RUSTFS_IMAGE"
        docker run -d --name "$RUSTFS_NAME" \
            --network "$NETWORK" \
            -e RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
            -e RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
            -e RUSTFS_VOLUMES=/data \
            "$RUSTFS_IMAGE" >/dev/null
    fi
    b "[RustFS] waiting for ready"
    for _ in $(seq 1 20); do
        # RustFS / S3 endpoints answer on / with a 200 or auth-challenge — both
        # mean the server is alive enough to serve PUTs.
        if docker exec "$RUSTFS_NAME" sh -c 'wget -q -O - --timeout=2 http://localhost:9000/ >/dev/null 2>&1 || curl -sf -m 2 http://localhost:9000/ >/dev/null 2>&1' ; then
            return 0
        fi
        sleep 0.5
    done
    # Don't fail the whole sandbox on RustFS readiness — server falls back to
    # local-disk if RustFS is unreachable. Just warn and continue.
    echo "  ${YLW:-}note: RustFS readiness check timed out; server will use local-disk fallback if needed${OFF:-}"
    return 0
}

# Collabora CODE next to NC. Three URLs are in play and they are NOT the same:
#   wopi_url          NC → Collabora, server to server: the container name.
#   public_wopi_url   the browser loads the editor iframe from here: the host
#                     port, on localhost (or LAN_IP, so another device works).
#   wopi_callback_url Collabora → NC, to fetch and save the file: the front
#                     (HaRP) or NC itself — never "localhost", which inside the
#                     Collabora container is Collabora.
# `aliasgroup1` is the list of NC origins Collabora will serve for; a browser
# origin missing from it gets a blank editor and a "WOPI host not allowed" in
# the Collabora log.
# `mount_jail_tree=false`: CODE 26.x builds its per-document jails with
# coolmount, which needs CAP_SYS_ADMIN under Docker's default seccomp profile.
# Without that every kit child died at start and Files showed "Failed to load
# Nextcloud Office" (measured 2026-09-18). Copying the jail tree instead costs
# a slower first child and no extra capability — the trade Collabora itself
# documents for exactly this case.
# `server_name` is what Collabora writes into its discovery as the editor URL.
# Left empty it echoes the REQUEST host — and Nextcloud fetches the discovery
# over the container name, so the browser was handed
# http://bee-flow-collabora:9980/…/cool.html, a name it cannot resolve
# (measured 2026-09-18: the token was issued, then nothing ever reached
# Collabora). richdocuments' own source says the same: the public URL is
# derived from the discovery, never from public_wopi_url.
start_office() {
    local pub_bind="127.0.0.1:"
    [ -n "$LAN_IP" ] && pub_bind=""
    local public_host="localhost:${OFFICE_PORT}"
    [ -n "$LAN_IP" ] && public_host="${LAN_IP}:${OFFICE_PORT}"
    local aliases="http://localhost:${NC_PORT},http://${NC_NAME}:80,http://${FRONT_NAME}:80"
    [ -n "$LAN_IP" ] && aliases="${aliases},http://${LAN_IP}:${NC_PORT}"
    if docker ps --format '{{.Names}}' | grep -qx "$OFFICE_NAME"; then
        b "[Office] $OFFICE_NAME already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$OFFICE_NAME"; then
        b "[Office] starting existing $OFFICE_NAME"
        docker start "$OFFICE_NAME" >/dev/null
    else
        b "[Office] launching $OFFICE_IMAGE"
        docker run -d --name "$OFFICE_NAME" \
            --network "$NETWORK" \
            --restart unless-stopped \
            --cap-add MKNOD \
            -p "${pub_bind}${OFFICE_PORT}:9980" \
            -e "aliasgroup1=${aliases}" \
            -e "server_name=${public_host}" \
            -e "extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:mount_jail_tree=false" \
            -e "dictionaries=nl_NL en_US de_DE" \
            "$OFFICE_IMAGE" >/dev/null
    fi
    b "[Office] waiting for Collabora discovery"
    for _ in $(seq 1 60); do
        if curl -sf -m 2 "http://127.0.0.1:${OFFICE_PORT}/hosting/discovery" 2>/dev/null | grep -q wopi-discovery; then
            return 0
        fi
        sleep 1
    done
    echo "  ${YLW:-}note: Collabora did not answer within 60s; Office may need a moment more (docker logs $OFFICE_NAME)${OFF:-}"
    return 0
}

# The NC side. `richdocuments:activate-config` fetches Collabora's discovery,
# derives public_wopi_url from it (correct now that server_name is set) and
# CLEARS wopi_callback_url — so the callback is set after it, every time.
# The web workers cache the discovery in APCu for an hour, which the CLI
# cannot flush: on a sandbox that was already up, Office may take up to an
# hour to see a changed Collabora URL (docker restart $NC_NAME forces it).
configure_office() {
    if ! nc_occ app:list 2>/dev/null | grep -qE '^\s+- richdocuments:'; then
        b "[Office] installing richdocuments"
        nc_occ app:install richdocuments 2>&1 | tail -1 || true
    fi
    nc_occ app:enable richdocuments >/dev/null 2>&1 || {
        echo "  ${YLW:-}note: richdocuments could not be installed (appstore unreachable?) — Office skipped; rerun 'up' later${OFF:-}"
        return 0
    }
    local callback="http://${NC_NAME}"
    [ "$HARP" = "1" ] && callback="http://${FRONT_NAME}"
    nc_occ config:app:set richdocuments wopi_url --value="http://${OFFICE_NAME}:9980" >/dev/null
    nc_occ config:app:set richdocuments disable_certificate_verification --value="yes" >/dev/null
    nc_occ richdocuments:activate-config >/dev/null 2>&1 || true
    nc_occ config:app:set richdocuments wopi_callback_url --value="$callback" >/dev/null
    b "[Office] richdocuments → $OFFICE_NAME (browser: $(nc_occ config:app:get richdocuments public_wopi_url 2>/dev/null), callback: $callback)"
}

# Tunnel the local NC at $NC_NAME:80 to a public https URL so that the cloud
# Bee Flow SaaS (server.beeflow.nl) can call back to verify NC ownership
# during bootstrap. Returns the public URL on stdout (e.g.
# `https://9f8e7d.ngrok-free.app`). No-op when NGROK_AUTHTOKEN is unset.
start_ngrok() {
    [ -z "$NGROK_AUTHTOKEN" ] && return 0

    if ! docker ps --format '{{.Names}}' | grep -qx "$NGROK_NAME"; then
        docker rm -f "$NGROK_NAME" >/dev/null 2>&1 || true
        b "[ngrok] launching $NGROK_IMAGE → $NC_NAME:80" >&2
        # `--log=stdout` is critical: without it ngrok writes to a file we
        # can't tail, and we have no way to know it's ready. Port 4040 is
        # the local API for tunnel introspection (only exposed on the
        # internal docker network — not published).
        docker run -d --name "$NGROK_NAME" \
            --network "$NETWORK" \
            -e NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN" \
            "$NGROK_IMAGE" \
            http "$NC_NAME:80" --log=stdout >/dev/null
    fi

    b "[ngrok] waiting for public URL" >&2
    for _ in $(seq 1 30); do
        # Tunnels API returns JSON; jq isn't installed in the alpine ngrok
        # image, so grep+sed the URL out. Match https only — the http and
        # https tunnels are both listed; we want the https one for callback
        # to actually succeed against NC.
        url=$(docker exec "$NGROK_NAME" wget -qO- http://localhost:4040/api/tunnels 2>/dev/null \
            | grep -oE '"public_url":"https://[^"]+"' | head -1 | sed 's/.*"\(https:[^"]*\)"/\1/')
        if [ -n "$url" ]; then
            echo "$url"
            return 0
        fi
        sleep 1
    done
    r "ngrok did not produce a public URL within 30s — check 'docker logs $NGROK_NAME'"
    return 1
}

# cloudflared quick-tunnel — same purpose as start_ngrok but no signup, no
# authtoken. The tunnel URL changes on every restart (e.g.
# https://random-words.trycloudflare.com), which is fine for a sandbox: each
# fresh `up` re-bootstraps with the new URL anyway.
start_cloudflared() {
    if ! docker ps --format '{{.Names}}' | grep -qx "$CFD_NAME"; then
        docker rm -f "$CFD_NAME" >/dev/null 2>&1 || true
        b "[cloudflared] launching → $NC_NAME:80" >&2
        # `--no-autoupdate` keeps the container deterministic; `--url`
        # creates a quick-tunnel (anonymous, no Cloudflare account).
        docker run -d --name "$CFD_NAME" \
            --network "$NETWORK" \
            "$CFD_IMAGE" \
            tunnel --no-autoupdate --url "http://$NC_NAME:80" >/dev/null
    fi

    b "[cloudflared] waiting for public URL" >&2
    for _ in $(seq 1 30); do
        # cloudflared logs the URL within ~5s, e.g.:
        #   "Your quick Tunnel has been created!  https://<words>.trycloudflare.com"
        url=$(docker logs "$CFD_NAME" 2>&1 \
            | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
        if [ -n "$url" ]; then
            echo "$url"
            return 0
        fi
        sleep 1
    done
    r "cloudflared did not produce a public URL within 30s — check 'docker logs $CFD_NAME'"
    return 1
}

# Picks an available public-tunnel implementation. Preference order:
#   1. ngrok      — when NGROK_AUTHTOKEN set; named *.ngrok-free.app URL
#   2. cloudflared — default; *.trycloudflare.com, no signup
start_public_tunnel() {
    if [ -n "$NGROK_AUTHTOKEN" ]; then
        start_ngrok
    else
        start_cloudflared
    fi
}

run_server_migrations() {
    b "[Server] running migrations"
    docker run --rm --network "$NETWORK" \
        -e CORE_DATABASE_URL="postgres://beeflow:$PG_PASSWORD@$PG_NAME:5432/beeflow" \
        "$SERVER_IMAGE" \
        node migrateDb.js 2>&1 | tail -5 || true
}

start_server() {
    if docker ps --format '{{.Names}}' | grep -qx "$SRV_NAME"; then
        b "[Server] $SRV_NAME already running — reusing"
        return 0
    fi
    docker rm -f "$SRV_NAME" >/dev/null 2>&1 || true
    b "[Server] launching $SERVER_IMAGE on :$SERVER_PORT"
    docker run -d --name "$SRV_NAME" \
        --network "$NETWORK" \
        -p "$SERVER_PORT:$SERVER_PORT" \
        -e PORT="$SERVER_PORT" \
        -e NODE_ENV=development \
        -e SESSION_SECRET=dev-session-secret-change-me-at-least-32-chars \
        -e MASTER_ENCRYPTION_KEY=dev-master-encryption-key-32-chars-min \
        -e BEEFLOW_BOOTSTRAP_SKIP_VERIFY=true \
        -e CORE_DATABASE_URL="postgres://beeflow:$PG_PASSWORD@$PG_NAME:5432/beeflow" \
        -e RUSTFS_ENDPOINT="http://$RUSTFS_NAME:9000" \
        -e RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
        -e RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
        -e CORS_ORIGIN="http://localhost:$NC_PORT,http://$NC_NAME${LAN_IP:+,http://$LAN_IP:$NC_PORT}" \
        -e COOKIE_SECURE=false \
        "$SERVER_IMAGE" >/dev/null

    b "[Server] waiting for /api/health"
    for _ in $(seq 1 60); do
        if curl -sf -m 1 "http://localhost:$SERVER_PORT/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    r "Server failed to become healthy in 60s — check: docker logs $SRV_NAME"
    return 1
}

ensure_server_image() {
    if docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1; then
        b "[Server] image $SERVER_IMAGE already present"
        return 0
    fi
    b "[Server] pulling $SERVER_IMAGE"
    docker pull "$SERVER_IMAGE"
}

# ─── Nextcloud container + worker sidecar ────────────────────────────────────

# run_nc_container <html-volume|"">. Publishes :$NC_PORT unless in HaRP mode,
# where the front door owns that port.
run_nc_container() {
    local vol="$1" args=()
    [ "$HARP" = "1" ] || args+=(-p "$NC_PORT:80")
    [ -z "$vol" ]     || args+=(-v "$vol:/var/www/html")
    docker run -d --name "$NC_NAME" --network "$NETWORK" \
        ${args[@]+"${args[@]}"} \
        "nextcloud:$NC_VERSION" >/dev/null
}

# Sets NC_RECREATED=1 when a new NC container was created this run (fresh or
# migrated), so HaRP can be told to re-resolve it.
ensure_nc_container() {
    NC_RECREATED=0
    local want_port=1
    [ "$HARP" = "1" ] && want_port=0
    if container_exists "$NC_NAME"; then
        local has_port=0
        publishes_host_port "$NC_NAME" && has_port=1
        if [ "$has_port" != "$want_port" ]; then
            # Same /var/www/html volume, other port posture. The old shell is
            # parked as $NC_NAME-old (removed by `down`); its anonymous volume
            # is what the new container mounts by name.
            local vol
            vol=$(nc_html_volume "$NC_NAME")
            if [ "$want_port" = 1 ]; then
                b "[2/7] $NC_NAME has no host port (HaRP-mode container) — recreating with -p $NC_PORT:80 on the same volume"
            else
                b "[2/7] $NC_NAME publishes :$NC_PORT (default-mode container) — recreating without a host port on the same volume; $FRONT_NAME takes :$NC_PORT"
            fi
            docker stop "$NC_NAME" >/dev/null 2>&1 || true
            docker rm -f "${NC_NAME}-old" >/dev/null 2>&1 || true
            docker rename "$NC_NAME" "${NC_NAME}-old"
            run_nc_container "$vol"
            NC_RECREATED=1
        elif container_running "$NC_NAME"; then
            b "[2/7] $NC_NAME already running"
        else
            b "[2/7] Starting existing $NC_NAME"
            docker start "$NC_NAME" >/dev/null
        fi
    else
        if [ "$want_port" = 1 ]; then
            b "[2/7] Launching Nextcloud $NC_VERSION on :$NC_PORT"
        else
            b "[2/7] Launching Nextcloud $NC_VERSION (no host port — reached through $FRONT_NAME on :$NC_PORT)"
        fi
        run_nc_container ""
        NC_RECREATED=1
    fi
}

# Sidecar on NC's volume: drains WebhookCall jobs (that is how Nextcloud
# delivers events to the connector) and runs cron.php. The nextcloud image's
# apache container never runs a worker, so without this every webhook sits in
# the job queue until someone hits cron.php by hand.
start_nc_worker() {
    local vol
    vol=$(nc_html_volume "$NC_NAME")
    if [ -z "$vol" ]; then
        r "[worker] cannot determine $NC_NAME's /var/www/html volume — skipping $WORKER_NAME"
        return 0
    fi
    if container_exists "$WORKER_NAME"; then
        if [ "$(nc_html_volume "$WORKER_NAME")" != "$vol" ] \
           || [ "$(docker inspect --format '{{.Config.Image}}' "$WORKER_NAME" 2>/dev/null || true)" != "nextcloud:$NC_VERSION" ]; then
            b "[worker] $WORKER_NAME is bound to another volume/image — recreating"
            docker rm -f "$WORKER_NAME" >/dev/null
        elif container_running "$WORKER_NAME"; then
            b "[worker] $WORKER_NAME already running"
            return 0
        else
            b "[worker] starting existing $WORKER_NAME"
            docker start "$WORKER_NAME" >/dev/null
            return 0
        fi
    fi
    b "[worker] launching $WORKER_NAME (webhook worker + cron.php on $NC_NAME's volume)"
    # `-t 55` bounds each worker pass so cron.php gets its turn; `|| true` +
    # sleep keeps the loop from spinning while Nextcloud is still installing.
    # The single-quoted script reaches the container's sh verbatim, and inside
    # it the double quotes keep the PHP namespace backslashes intact.
    docker run -d --name "$WORKER_NAME" \
        --network "$NETWORK" --restart unless-stopped \
        -u www-data -w /var/www/html \
        -v "$vol:/var/www/html" \
        --entrypoint sh "nextcloud:$NC_VERSION" -c '
            while true; do
                php occ background-job:worker -t 55 "OCA\WebhookListeners\BackgroundJobs\WebhookCall" || true
                php -f cron.php || true
                sleep 5
            done' >/dev/null
}

# ─── HaRP mode helpers ───────────────────────────────────────────────────────

ensure_harp_key() {
    mkdir -p "$SANDBOX_DIR"
    chmod 700 "$SANDBOX_DIR" 2>/dev/null || true
    if [ ! -s "$HARP_KEY_FILE" ]; then
        b "[HaRP] generating shared key → $HARP_KEY_FILE"
        # 64 random bytes → 88 base64 chars, so 40 alphanumerics always
        # survive the filter (32 bytes would not: 44 chars minus +/=).
        local key
        key=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
        ( umask 077; printf '%s\n' "${key:0:40}" >"$HARP_KEY_FILE" )
    fi
    chmod 600 "$HARP_KEY_FILE"
    HARP_KEY=$(tr -d '[:space:]' <"$HARP_KEY_FILE")
    if [ -z "$HARP_KEY" ]; then
        r "empty HaRP key in $HARP_KEY_FILE — delete the file and rerun"
        exit 1
    fi
}

# What HaRP should treat as a proxy (and read X-Forwarded-For from). The front
# door lives on $NETWORK, so that subnet — one CIDR, same shape as the value
# proven by hand (172.16.0.0/12), but also right when Docker hands out a
# 192.168.x pool.
harp_trusted_proxy_ips() {
    if [ -n "$HARP_TRUSTED_PROXY_IPS" ]; then
        echo "$HARP_TRUSTED_PROXY_IPS"
        return 0
    fi
    local subnet
    subnet=$(docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | awk '{print $1}' || true)
    echo "${subnet:-172.16.0.0/12}"
}

start_harp() {
    docker volume create "$HARP_CERTS_VOL" >/dev/null
    if container_exists "$HARP_NAME" && [ "$(container_env "$HARP_NAME" HP_SHARED_KEY)" != "$HARP_KEY" ]; then
        b "[HaRP] $HARP_NAME runs with a different shared key than $HARP_KEY_FILE — recreating"
        docker rm -f "$HARP_NAME" >/dev/null
    fi
    if container_running "$HARP_NAME"; then
        if [ "${NC_RECREATED:-0}" = "1" ]; then
            b "[HaRP] Nextcloud was recreated — restarting $HARP_NAME so it re-resolves $NC_NAME"
            docker restart "$HARP_NAME" >/dev/null
        else
            b "[HaRP] $HARP_NAME already running"
        fi
    elif container_exists "$HARP_NAME"; then
        b "[HaRP] starting existing $HARP_NAME"
        docker start "$HARP_NAME" >/dev/null
    else
        local proxy_ips
        proxy_ips=$(harp_trusted_proxy_ips)
        b "[HaRP] launching $HARP_IMAGE (manual-install flavour, trusted proxies: $proxy_ips)"
        # No docker socket: manual-install daemons never ask HaRP to deploy.
        # BLACKLIST 50/60s instead of 10/300s — a sandbox produces bad
        # responses on purpose while you iterate.
        docker run -d --name "$HARP_NAME" -h "$HARP_NAME" \
            --network "$NETWORK" --restart unless-stopped \
            -e HP_SHARED_KEY="$HARP_KEY" \
            -e NC_INSTANCE_URL="http://$NC_NAME" \
            -e HP_LOG_LEVEL=info \
            -e HP_TRUSTED_PROXY_IPS="$proxy_ips" \
            -e HP_BLACKLIST_COUNT=50 \
            -e HP_BLACKLIST_WINDOW=60 \
            -v "$HARP_CERTS_VOL:/certs" \
            "$HARP_IMAGE" >/dev/null
    fi
    # The connector mounts this volume read-only and harp-start.sh falls back
    # to a plaintext frpc config when /certs/frp is missing — which HaRP's
    # TLS-only frps then rejects. So wait until the certs exist.
    b "[HaRP] waiting for FRP certificates in $HARP_CERTS_VOL"
    for _ in $(seq 1 60); do
        if docker exec "$HARP_NAME" sh -c 'test -s /certs/frp/client.crt && test -s /certs/frp/client.key && test -s /certs/frp/ca.crt' 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    r "HaRP did not produce /certs/frp/* within 60s — check: docker logs $HARP_NAME"
    return 1
}

write_front_conf() {
    mkdir -p "$SANDBOX_DIR"
    cat >"$FRONT_CONF" <<EOF
# Generated by local-sandbox.sh (HARP=1) on every \`up\` — edits are overwritten.
# /exapps/ → HaRP → FRP tunnel → connector; everything else → Nextcloud.
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    server_name _;
    client_max_body_size 0;
    proxy_http_version 1.1;

    # The forwarding headers are repeated INSIDE each location on purpose.
    # nginx inherits proxy_set_header from the server level only when the
    # location defines none of its own — and both locations set Upgrade /
    # Connection, which silently dropped the server-level set. Nextcloud then
    # saw Host = $NC_NAME (the upstream name): the post-login redirect and
    # every absolute URL pointed there, and Nextcloud Office told Collabora
    # to postMessage to http://$NC_NAME/ while the page sat on
    # localhost:$NC_PORT — "Failed to load Nextcloud Office" after 15 s
    # (measured 2026-09-18).
    # \$http_host keeps the port (localhost:$NC_PORT); \$host strips it.

    location /exapps/ {
        proxy_pass http://$HARP_NAME:$HARP_PROXY_PORT/exapps/;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        # SSE: never buffer, and outlive HaRP's own 1800 s server timeout.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }

    location / {
        proxy_pass http://$NC_NAME:80;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
EOF
}

start_front() {
    write_front_conf
    # Always recreated: nginx resolves its two upstream names once, at start,
    # so a HaRP or Nextcloud container recreated since then (new IP) would
    # leave an old front proxying into the void. It is stateless and starts
    # in well under a second. The config is copied in rather than bind-
    # mounted so paths with spaces / Windows drive letters can't trip `-v`.
    docker rm -f "$FRONT_NAME" >/dev/null 2>&1 || true
    b "[front] launching $FRONT_IMAGE on :$NC_PORT (/exapps/ → $HARP_NAME:$HARP_PROXY_PORT, / → $NC_NAME)"
    docker create --name "$FRONT_NAME" \
        --network "$NETWORK" --restart unless-stopped \
        -p "$NC_PORT:80" \
        "$FRONT_IMAGE" >/dev/null
    docker cp "$FRONT_CONF" "$FRONT_NAME:/etc/nginx/conf.d/default.conf"
    docker start "$FRONT_NAME" >/dev/null
    b "[front] waiting for http://localhost:$NC_PORT/status.php"
    for _ in $(seq 1 30); do
        if curl -sf -m 2 "http://localhost:$NC_PORT/status.php" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    r "front door did not come up on :$NC_PORT — check: docker logs $FRONT_NAME"
    return 1
}

# The header AppAPI puts on its own calls to the ExApp. An anonymous probe
# through HaRP can 502 while Nextcloud's authenticated heartbeats succeed, so
# probes in HaRP mode carry it.
aa_probe_header() {
    printf 'AUTHORIZATION-APP-API: %s' "$(printf 'admin:%s' "$SECRET" | base64 | tr -d '\n')"
}

# Unregister the ExApp and scrub its rows so it can be re-created (on another
# daemon, or from a newer info.xml). Extra args go to `app:unregister`
# (`--silent` skips the goodbye call to a container that is gone anyway).
unregister_exapp() {
    nc_occ app_api:app:disable "$APP_ID" 2>/dev/null | tail -1 || true
    nc_occ app_api:app:unregister "$APP_ID" "$@" 2>/dev/null | tail -1 || true
    nc_sql "DELETE FROM oc_ex_apps WHERE appid='$APP_ID'; DELETE FROM oc_ex_apps_routes WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_top_menu WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_scripts WHERE appid='$APP_ID';" 2>/dev/null || true
}

# Step 5: the deployment daemon the ExApp is registered on. Sets
# FORCE_REREGISTER=1 when the ExApp had to be torn down along the way.
ensure_daemon() {
    FORCE_REREGISTER=0
    if [ "$HARP" = "1" ]; then
        local want_host="$HARP_NAME:$HARP_PROXY_PORT" want_url="http://$FRONT_NAME" row key_ok
        row=$(nc_sql "SELECT host||'|'||nextcloud_url FROM oc_ex_apps_daemons WHERE name='$DAEMON';" 2>/dev/null || echo "")
        key_ok=$(nc_sql "SELECT count(*) FROM oc_ex_apps_daemons WHERE name='$DAEMON' AND deploy_config LIKE '%$HARP_KEY%';" 2>/dev/null || echo 0)
        if [ -n "$row" ] && { [ "$row" != "$want_host|$want_url" ] || [ "${key_ok:-0}" = "0" ]; }; then
            b "[5/7] Daemon $DAEMON is stale (host|url='$row', shared key current: ${key_ok:-0}) — re-registering"
            # The ExApp has to come off the daemon first, and it must be
            # re-created on the fresh one anyway.
            unregister_exapp --silent
            nc_occ app_api:daemon:unregister "$DAEMON" 2>&1 | tail -1 || true
            FORCE_REREGISTER=1
        fi
        if ! nc_occ app_api:daemon:list 2>/dev/null | grep -qw "$DAEMON"; then
            b "[5/7] Registering $DAEMON daemon (manual-install + HaRP; host=$want_host, nextcloud_url=$want_url)"
            # nextcloud_url is the FRONT: ManualActions::resolveExAppUrl returns
            # {nextcloud_url}/exapps/<app>, and that is the URL Nextcloud's PHP
            # uses for heartbeat / init / every call to the app.
            nc_occ app_api:daemon:register \
                "$DAEMON" "HaRP (manual)" manual-install http "$want_host" "$want_url" \
                --net "$NETWORK" --harp \
                --harp_frp_address "$HARP_NAME:$HARP_FRP_PORT" \
                --harp_shared_key "$HARP_KEY" 2>&1 | tail -1
        else
            b "[5/7] Daemon $DAEMON already registered (host=$want_host, nextcloud_url=$want_url)"
        fi
        return 0
    fi

    # Daemon's host MUST be the connector container's name — that's how
    # AppAPI builds the heartbeat URL (http://<host>:<exapp-port>/heartbeat).
    # NC reaches it via Docker's embedded DNS on the shared $NETWORK.
    # Re-register if the daemon's host is wrong (legacy "host.docker.internal"
    # value from older runs).
    local daemon_host_in_db
    daemon_host_in_db=$(nc_sql "SELECT host FROM oc_ex_apps_daemons WHERE name='$DAEMON';" 2>/dev/null || echo "")
    if [ -n "$daemon_host_in_db" ] && [ "$daemon_host_in_db" != "$CONN_NAME" ]; then
        b "[5/7] Daemon $DAEMON has stale host '$daemon_host_in_db' — re-registering with '$CONN_NAME'"
        nc_occ app_api:daemon:unregister "$DAEMON" 2>&1 | tail -1 || true
    fi
    if ! nc_occ app_api:daemon:list 2>/dev/null | grep -qw "$DAEMON"; then
        b "[5/7] Registering $DAEMON daemon (host=$CONN_NAME, networked)"
        nc_occ app_api:daemon:register \
            "$DAEMON" "Manual Local" manual-install http "$CONN_NAME" "http://$NC_NAME" 2>&1 | tail -1
    else
        b "[5/7] Daemon $DAEMON already registered (host=$daemon_host_in_db)"
    fi
}

cmd_up() {
    docker info >/dev/null 2>&1 || { r "Docker daemon is not reachable"; exit 1; }

    if [ "$HARP" = "1" ]; then
        DAEMON="$HARP_DAEMON"
        b "[HaRP] HaRP mode: browser → $FRONT_NAME:$NC_PORT → /exapps/ → $HARP_NAME → FRP tunnel → connector (no PHP proxy); daemon $DAEMON"
    fi

    # --cloud — point connector at https://server.beeflow.nl instead of the
    # local SaaS, skip the Postgres+RustFS+server stack, and start a public
    # tunnel so the cloud can callback-verify the NC instance.
    if [ "$CLOUD_MODE" = "1" ]; then
        WITH_SERVER=0
        API_BASE_URL="https://server.beeflow.nl"
        # The cached tenant key is one file, not keyed by server — a key the
        # cloud minted must never be replayed against the local stack.
        CONN_DATA_VOL="${CONN_DATA_VOL}-cloud"
        b "[cloud] Connector will target $API_BASE_URL; local SaaS stack disabled"
    fi

    # Image source priority:
    #   1. Already-loaded local image  → reuse
    #   2. Image looks like a registry path (contains '/' and a registry host
    #      such as ghcr.io / docker.io)  → docker pull
    #   3. Plain local tag (no registry host)  → docker build from CONNECTOR_DIR
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        b "[1/7] Reusing existing $IMAGE"
    elif [[ "$IMAGE" == *"/"*"/"* ]] || [[ "$IMAGE" == ghcr.io/* ]] || [[ "$IMAGE" == */* && "$IMAGE" != "library/"* && "$IMAGE" =~ \. ]]; then
        b "[1/7] Pulling $IMAGE from registry"
        docker pull "$IMAGE"
    else
        b "[1/7] Building $IMAGE locally (~1-3 min one-off; pre-built dev images live at ghcr.io/bee-flow/connector:dev)"
        # Self-contained build: Dockerfile clones Bee-Flow/hive anonymously
        # over HTTPS at build time. Context is the connector dir only — no
        # agent-hub/ sibling, no SSH key, no GitHub token required.
        docker build -t "$IMAGE" "$CONNECTOR_DIR"
    fi

    # Ensure shared docker network exists. All sandbox containers attach so
    # they can resolve each other by container name (no host.docker.internal).
    if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
        docker network create "$NETWORK" >/dev/null
    fi

    # ─── Server stack (Postgres + RustFS + Bee Flow server) ──────────────
    if [ "$WITH_SERVER" = "1" ]; then
        ensure_server_image
        start_postgres
        start_rustfs
        run_server_migrations
        start_server
    else
        b "[Server] WITH_SERVER=0 — skipping server stack; connector will hit $API_BASE_URL"
    fi

    # ─── Nextcloud (+ HaRP, front door) ──────────────────────────────────
    if [ "$HARP" = "1" ]; then
        ensure_harp_key
    else
        # Leftovers from a HaRP-mode run: the front holds :$NC_PORT, which
        # Nextcloud itself needs back in this mode. No-op if never used.
        for c in "$FRONT_NAME" "$HARP_NAME"; do
            if container_exists "$c"; then
                b "[2/7] Removing HaRP-mode container $c (HARP=0)"
                docker rm -f "$c" >/dev/null
            fi
        done
    fi

    ensure_nc_container

    # Existing NC container may have been started before $NETWORK existed —
    # attach it now if it isn't already on the network.
    if ! docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$NC_NAME"; then
        docker network connect "$NETWORK" "$NC_NAME" 2>/dev/null || true
    fi

    if [ "$HARP" = "1" ]; then
        start_harp
    fi

    b "[3/7] Waiting for apache"
    until docker exec "$NC_NAME" curl -sf http://127.0.0.1/status.php >/dev/null 2>&1; do sleep 2; done

    # Disable Apache mod_deflate so SSE responses (e.g. /ai/chat/direct/stream)
    # aren't gzip-buffered before reaching the browser. With deflate on, the
    # SPA's chat UI sees a partial / corrupted stream and prints "Error
    # generating response" while the cloud is actually streaming fine.
    # Idempotent: a2dismod is a no-op if already disabled.
    if docker exec "$NC_NAME" sh -c 'apache2ctl -M 2>/dev/null | grep -q deflate_module'; then
        docker exec "$NC_NAME" a2dismod -f deflate >/dev/null 2>&1 || true
        docker exec "$NC_NAME" apache2ctl restart 2>&1 | grep -v "fully qualified" >&2 || true
        # apache2ctl restart can briefly tear down the listener; wait for it back.
        until docker exec "$NC_NAME" curl -sf http://127.0.0.1/status.php >/dev/null 2>&1; do sleep 1; done
    fi

    # The front resolves $HARP_NAME and $NC_NAME at start — both exist now.
    if [ "$HARP" = "1" ]; then
        start_front
    fi

    if ! nc_occ status 2>/dev/null | grep -q 'installed: true'; then
        b "[4/7] Installing Nextcloud (admin/admin)"
        nc_occ maintenance:install --database=sqlite --admin-user=admin --admin-pass=admin >/dev/null
    else
        b "[4/7] Nextcloud already installed"
    fi

    # The connector mints SaaS-bound JWTs from the NC user record; the SaaS
    # rejects JWTs with no `email` claim (400 "Connector token missing email
    # claim"). NC's default admin has no email, so set one — idempotent.
    nc_occ user:setting admin settings email admin@example.com >/dev/null 2>&1 || true

    # Jobs run from the worker sidecar, not from web requests, and Nextcloud
    # must be allowed to call a private address: without
    # allow_local_remote_servers every webhook/init call to the connector
    # dies with "violates local access rules". Both idempotent.
    nc_occ background:cron >/dev/null 2>&1 || true
    nc_occ config:system:set allow_local_remote_servers --value=true --type=boolean >/dev/null
    start_nc_worker

    # Public tunnel for Cloud-mode bootstrap. The cloud SaaS verifies NC
    # ownership by calling back to ${ncBaseUrl}/ocs/.../capabilities; the
    # Docker-internal hostname $NC_NAME isn't reachable from the public
    # internet, so we expose NC at a public https URL and pass that to the
    # connector as BEEFLOW_NC_PUBLIC_URL. Only the bootstrap claim uses it;
    # internal connector→NC traffic still goes via $NC_NAME.
    #
    # Tunnel auto-starts when --cloud is passed (cloudflared by default,
    # ngrok if NGROK_AUTHTOKEN is set). Without --cloud, only fires when an
    # NGROK_AUTHTOKEN is explicitly provided (preserves prior behaviour).
    NC_PUBLIC_URL=""
    if [ "$CLOUD_MODE" = "1" ] || [ -n "$NGROK_AUTHTOKEN" ]; then
        NC_PUBLIC_URL=$(start_public_tunnel)
        if [ -n "$NC_PUBLIC_URL" ]; then
            tunnel_host="${NC_PUBLIC_URL#https://}"
            b "[tunnel] adding $tunnel_host to NC trusted_domains"
            # Reserve slot 2 for the tunnel host (slot 0=localhost, 1=$NC_NAME).
            # Adding to trusted_domains is enough — NC will accept inbound
            # requests at this host (which the cloud SaaS hits during the
            # one-off bootstrap callback). DO NOT set overwritehost: that
            # makes NC redirect ALL browser traffic to the cloudflared URL,
            # routing the user's interactive session through a flaky free
            # tunnel (SSE 520, request rate limits, etc.). The user should
            # keep browsing http://localhost:$NC_PORT directly.
            nc_occ config:system:set trusted_domains 2 --value="$tunnel_host" >/dev/null
            # Defensive: clear overwritehost / overwriteprotocol if a prior
            # version of this script (or a previous run) set them.
            nc_occ config:system:delete overwritehost >/dev/null 2>&1 || true
            nc_occ config:system:delete overwriteprotocol >/dev/null 2>&1 || true
        fi
    fi

    # Links Nextcloud builds OUTSIDE a browser request — cron, notifications,
    # occ, the share-by-mail body — come from overwrite.cli.url. The image
    # defaults it to http://localhost, i.e. port 80: every such link pointed
    # at a port nothing listens on. Browser-side links use the request Host
    # (the front forwards it; see write_front_conf), so this is the one
    # place the port has to be said.
    nc_occ config:system:set overwrite.cli.url --value="http://localhost:$NC_PORT" >/dev/null

    # Trusted domains — must include every hostname the connector / browser
    # uses to reach NC. Without these, NC returns its web-UI HTML for OCS
    # calls instead of JSON, which breaks the connector's /init flow
    # (TopMenu / EmbedScript / events_listener registrations all 400).
    #   localhost        → for the browser (already default-trusted)
    #   $NC_NAME         → for the connector calling NC over the shared network
    #   $FRONT_NAME      → (HaRP) Nextcloud's own calls to /exapps/ go through
    #                      the front, so its PHP sees that as the Host
    #   $LAN_IP          → (optional) another device on the LAN
    nc_occ config:system:set trusted_domains 1 --value="$NC_NAME" >/dev/null
    if [ "$HARP" = "1" ]; then
        nc_trust_domain "$FRONT_NAME"
    fi
    if [ -n "$LAN_IP" ]; then
        nc_trust_domain "$LAN_IP"
    fi

    nc_occ app:install app_api 2>&1 | tail -1 || true
    if [ "$WITH_OFFICE" = "1" ]; then
        start_office
        configure_office
    fi
    docker exec -e DEBIAN_FRONTEND=noninteractive "$NC_NAME" bash -c "command -v sqlite3 >/dev/null || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq sqlite3 >/dev/null 2>&1)" || true

    ensure_daemon

    # Re-register if the ExApp doesn't exist OR if `info.xml` is newer than
    # the registered row (so route/menu changes pick up automatically) OR if
    # it sits on the other mode's daemon OR if FORCE=1 was passed. Otherwise
    # NC's stored routes drift from info.xml silently.
    info_mtime=$(stat -c %Y "$CONNECTOR_DIR/appinfo/info.xml" 2>/dev/null || echo 0)
    db_ctime=$(nc_sql "SELECT created_time FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null || echo 0)
    db_daemon=$(nc_sql "SELECT daemon_config_name FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null || echo "")
    if [ -z "$db_ctime" ] || [ "${FORCE:-0}" = "1" ] || [ "$FORCE_REREGISTER" = "1" ] \
       || [ "$info_mtime" -gt "$db_ctime" ] || [ "$db_daemon" != "$DAEMON" ]; then
        b "[6/7] (Re-)registering ExApp $APP_ID on $DAEMON (info.xml mtime=$info_mtime, db ctime=$db_ctime, db daemon='${db_daemon:-none}')"
        if [ -n "$db_daemon" ] && [ "$db_daemon" != "$DAEMON" ]; then
            # Registered on the other mode's daemon: its container is being
            # replaced, so don't wait on a goodbye call to it.
            unregister_exapp --silent
        else
            unregister_exapp
        fi
        docker cp "$CONNECTOR_DIR/appinfo/info.xml" "$NC_NAME:/tmp/info.xml"

        # Run register in BACKGROUND. AppAPI inserts the row + secret + port
        # synchronously, then blocks polling for the connector's heartbeat.
        # That heartbeat can only succeed once we start the container — but
        # the container needs the port + secret which AppAPI just minted.
        # So we let register hang while we read the row, start the container,
        # and then block on register to finish.
        REGISTER_LOG=$(mktemp)
        nc_occ app_api:app:register "$APP_ID" "$DAEMON" \
            --info-xml /tmp/info.xml \
            --env "BEEFLOW_TENANT_KEY=$TENANT_KEY" \
            --env "BEEFLOW_API_BASE_URL=$API_BASE_URL" >"$REGISTER_LOG" 2>&1 &
        REGISTER_PID=$!

        b "[6/7] Waiting for AppAPI to provision port + secret"
        for i in $(seq 1 60); do
            PORT=$(nc_sql "SELECT port FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null)
            SECRET=$(nc_sql "SELECT secret FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null)
            [ -n "$PORT" ] && [ -n "$SECRET" ] && break
            sleep 0.5
        done
        if [ -z "$PORT" ] || [ -z "$SECRET" ]; then
            r "Timed out waiting for AppAPI to provision the ExApp row"
            kill "$REGISTER_PID" 2>/dev/null
            cat "$REGISTER_LOG" >&2
            rm -f "$REGISTER_LOG"
            exit 1
        fi
    else
        b "[6/7] ExApp $APP_ID already registered on $DAEMON (info.xml unchanged)"
        REGISTER_PID=""
        REGISTER_LOG=""
        SECRET=$(nc_sql "SELECT secret FROM oc_ex_apps WHERE appid='$APP_ID';")
        PORT=$(nc_sql "SELECT port FROM oc_ex_apps WHERE appid='$APP_ID';")
    fi

    docker rm -f "$CONN_NAME" >/dev/null 2>&1 || true
    conn_args=(
        -e APP_ID="$APP_ID" -e APP_VERSION="$APP_VERSION"
        -e APP_HOST=0.0.0.0 -e APP_PORT="$PORT"
        -e APP_SECRET="$SECRET"
        -e NEXTCLOUD_URL="http://$NC_NAME"
        -e BEEFLOW_NC_PUBLIC_URL="$NC_PUBLIC_URL"
        -e BEEFLOW_TENANT_KEY="$TENANT_KEY"
        -e BEEFLOW_API_BASE_URL="$API_BASE_URL"
    )
    if [ -n "$EMBED_BASE_URL" ]; then
        conn_args+=(-e BEEFLOW_EMBED_BASE_URL="$EMBED_BASE_URL")
    fi
    if [ "$HARP" = "1" ]; then
        # The browser now reaches the connector directly (via nginx → HaRP) on
        # an origin the connector otherwise never sees, so it has to be told
        # to trust it. NEXTCLOUD_URL stays the container name: connector → NC
        # OCS calls don't need the front.
        embed_origins="http://localhost:$NC_PORT${LAN_IP:+,http://$LAN_IP:$NC_PORT}"
        b "[7/7] Starting connector behind HaRP (unix socket → frpc → $HARP_NAME:$HARP_FRP_PORT; AppAPI port $PORT stays tunnel-only; data volume $CONN_DATA_VOL)"
        conn_args+=(
            -e HP_SHARED_KEY="$HARP_KEY"
            -e HP_FRP_ADDRESS="$HARP_NAME"
            -e HP_FRP_PORT="$HARP_FRP_PORT"
            -e APP_PERSISTENT_STORAGE=/data
            -e BEEFLOW_TRUSTED_EMBED_ORIGINS="$embed_origins"
            -v "$CONN_DATA_VOL:/data"
            -v "$HARP_CERTS_VOL:/certs:ro"
        )
    else
        b "[7/7] Starting connector on :$PORT (network=$NETWORK, name=$CONN_NAME)"
        conn_args+=(-p "$PORT:$PORT")
    fi
    docker run -d --name "$CONN_NAME" \
        --network "$NETWORK" \
        "${conn_args[@]}" \
        "$IMAGE" >/dev/null

    if [ "$HARP" = "1" ]; then
        # Wait for the connector through the same path Nextcloud uses. The
        # backgrounded register finishing (success or failure) is the other
        # signal that the app is reachable — or that AppAPI gave up.
        hb_url="http://localhost:$NC_PORT/exapps/$APP_ID/heartbeat"
        b "[7/7] Waiting for the connector through HaRP: $hb_url"
        hb_ok=0
        for i in $(seq 1 120); do
            if curl -sf -o /dev/null -m 2 -H "$(aa_probe_header)" -H "EX-APP-ID: $APP_ID" -H "EX-APP-VERSION: $APP_VERSION" "$hb_url"; then
                hb_ok=1
                break
            fi
            if [ -n "${REGISTER_PID:-}" ] && ! kill -0 "$REGISTER_PID" 2>/dev/null; then
                break
            fi
            sleep 0.5
        done

        # Cross-check the hop AppAPI itself takes: NC → front → HaRP → tunnel.
        b "[7/7] Verifying NC → $FRONT_NAME → $HARP_NAME → connector"
        if ! docker exec "$NC_NAME" curl -sf -o /dev/null -m 5 -H "$(aa_probe_header)" -H "EX-APP-ID: $APP_ID" -H "EX-APP-VERSION: $APP_VERSION" "http://$FRONT_NAME/exapps/$APP_ID/heartbeat" >/dev/null; then
            if [ "$hb_ok" = "1" ]; then
                r "Host probe succeeded but NC cannot reach http://$FRONT_NAME/exapps/$APP_ID/heartbeat — check trusted_domains ($FRONT_NAME) and allow_local_remote_servers"
            else
                r "Nextcloud cannot reach the connector at http://$FRONT_NAME/exapps/$APP_ID/heartbeat"
                r "Try: docker logs $HARP_NAME --tail 30                    (route / ban / tunnel)"
                r "     docker logs $CONN_NAME --tail 30 | grep -i frpc      (tunnel login)"
                r "     docker logs $FRONT_NAME --tail 30"
            fi
        fi
    else
        # Wait for connector /heartbeat (this also unblocks the backgrounded
        # register call). Probe via the host port-publish — the same endpoint
        # that NC will hit through the container network.
        b "[7/7] Waiting for connector /heartbeat on :$PORT"
        for i in $(seq 1 30); do
            if curl -sf -o /dev/null -m 1 "http://localhost:$PORT/heartbeat"; then
                break
            fi
            sleep 0.5
        done

        # Cross-check: NC must also be able to reach it via the network.
        b "[7/7] Verifying NC → connector connectivity"
        if ! docker exec "$NC_NAME" curl -sf -m 3 "http://$CONN_NAME:$PORT/heartbeat" >/dev/null; then
            r "NC cannot reach the connector at http://$CONN_NAME:$PORT/heartbeat"
            r "Try: docker network inspect $NETWORK   (both containers should be listed)"
            r "     docker logs $CONN_NAME --tail 30"
        fi
    fi

    # Now wait for the backgrounded register call to finish (it should
    # complete within seconds once heartbeat works).
    if [ -n "${REGISTER_PID:-}" ]; then
        wait "$REGISTER_PID" 2>/dev/null || true
        tail -1 "$REGISTER_LOG" 2>/dev/null
        rm -f "$REGISTER_LOG"
    fi

    # Force-bootstrap the deploy state. AppAPI's deploy step (image pull +
    # container start) was bypassed because we ran docker run ourselves;
    # set deploy=100 so AppAPI doesn't think it's mid-install. The /init
    # step will report progress autonomously as the container processes
    # its background setup.
    nc_sql "UPDATE oc_ex_apps SET status='{\"deploy\":100,\"init\":0,\"action\":\"\",\"type\":\"install\",\"error\":\"\"}' WHERE appid='$APP_ID';"
    nc_occ app_api:app:enable "$APP_ID" 2>&1 | tail -1

    g "✔ Sandbox up — http://localhost:$NC_PORT  (admin / admin)"
    if [ "$HARP" = "1" ]; then
        echo "  Mode:           HaRP — $FRONT_NAME:$NC_PORT → /exapps/ → $HARP_NAME:$HARP_PROXY_PORT → FRP → $CONN_NAME (SSE streams live)"
        echo "  ExApp URL:      http://localhost:$NC_PORT/exapps/$APP_ID/  (anonymous /heartbeat may 502 through HaRP; that is HaRP, not the connector)"
        echo "  HaRP logs:      docker logs -f $HARP_NAME"
        echo "  Shared key:     $HARP_KEY_FILE  (delete to rotate; 'up' re-registers the daemon)"
    else
        echo "  Connector port: $PORT  (heartbeat: http://localhost:$PORT/heartbeat)"
    fi
    if [ "$WITH_OFFICE" = "1" ]; then
        echo "  Office:         Collabora on http://localhost:$OFFICE_PORT  (docker logs -f $OFFICE_NAME)"
    fi
    echo "  Connector logs: docker logs -f $CONN_NAME"
    echo "  NC worker logs: docker logs -f $WORKER_NAME"
    if [ -n "$LAN_IP" ]; then
        echo "  LAN:            http://$LAN_IP:$NC_PORT"
    fi
    if [ -n "$NC_PUBLIC_URL" ]; then
        echo "  Public NC URL:  $NC_PUBLIC_URL  (Cloud-mode bootstrap callback)"
    fi
}

# Every container either mode may have created. Named volumes survive `down`
# (that is what keeps the tenant key and the FRP certs); see cmd_clean.
ALL_CONTAINERS=(
    "$FRONT_NAME" "$WORKER_NAME" "$NC_NAME" "${NC_NAME}-old" "$CONN_NAME" "$HARP_NAME"
    "$SRV_NAME" "$RUSTFS_NAME" "$PG_NAME" "$NGROK_NAME" "$CFD_NAME" "$OFFICE_NAME"
)

cmd_down() {
    local n=0 c
    for c in "${ALL_CONTAINERS[@]}"; do
        if docker rm -f "$c" >/dev/null 2>&1; then n=$((n + 1)); fi
    done
    if [ "$n" -gt 0 ]; then g "✔ stopped ($n containers removed)"; else echo "(nothing to stop)"; fi
}
cmd_clean() {
    cmd_down
    docker rmi "$IMAGE" 2>/dev/null && g "✔ connector image removed" || true
    # Server image is large (~1 GB) and tedious to re-pull — keep it cached
    # by default. Set FULL_CLEAN=1 to also remove it and Postgres/RustFS, the
    # HaRP + nginx images, and the two named volumes: the FRP certs (cheap to
    # re-mint) and the connector's /data — that one holds the cached tenant
    # key, and losing it makes the next `up` provision a fresh org on the SaaS.
    if [ "${FULL_CLEAN:-0}" = "1" ]; then
        docker rmi "$SERVER_IMAGE" 2>/dev/null && g "✔ server image removed" || true
        docker rmi "$RUSTFS_IMAGE" 2>/dev/null && g "✔ rustfs image removed" || true
        docker rmi "$PG_IMAGE" 2>/dev/null && g "✔ postgres image removed" || true
        docker rmi "$HARP_IMAGE" 2>/dev/null && g "✔ harp image removed" || true
        docker rmi "$FRONT_IMAGE" 2>/dev/null && g "✔ nginx image removed" || true
        docker rmi "$OFFICE_IMAGE" 2>/dev/null && g "✔ collabora image removed" || true
        local v
        for v in "$HARP_CERTS_VOL" "$CONN_DATA_VOL" "${CONN_DATA_VOL}-cloud"; do
            docker volume rm "$v" 2>/dev/null >/dev/null && g "✔ volume $v removed" || true
        done
        if [ -d "$SANDBOX_DIR" ]; then
            rm -rf "$SANDBOX_DIR" && g "✔ $SANDBOX_DIR removed (HaRP shared key + nginx conf)" || true
        fi
    fi
    docker network rm "$NETWORK" 2>/dev/null && g "✔ network removed" || true
}
cmd_logs()   { docker logs -f --tail 50 "$CONN_NAME"; }
cmd_status() {
    docker ps -a \
        --filter "name=$PG_NAME" \
        --filter "name=$RUSTFS_NAME" \
        --filter "name=$SRV_NAME" \
        --filter "name=$NC_NAME" \
        --filter "name=$WORKER_NAME" \
        --filter "name=$FRONT_NAME" \
        --filter "name=$HARP_NAME" \
        --filter "name=$CONN_NAME" \
        --filter "name=$OFFICE_NAME" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    curl -s "http://localhost:$NC_PORT/status.php" | head -c 200; echo
}

# Parse subcommand + flags. `--cloud` / `--harp` can appear after `up` (or
# before, when implicit `up` is used). They set CLOUD_MODE=1 / HARP=1, which
# cmd_up acts on. HARP=1 in the environment is equivalent to `--harp`.
SUBCMD="up"
# Relaunch ONLY the nginx front door (HaRP mode). It is stateless, so this is
# the cheap repair for the two ways it goes stale: HaRP or Nextcloud was
# recreated and got a new IP (nginx resolves its upstreams once, at start), or
# the container predates the switch from a bind-mounted config to `docker cp`
# — a front created that way mounted its config out of a temp dir, and the
# first reboot that wiped the dir left it dead on
# "error mounting … not a directory", with :$NC_PORT answering nothing while
# Nextcloud itself was up and healthy behind it.
cmd_front() {
    docker info >/dev/null 2>&1 || { r "Docker daemon is not reachable"; exit 1; }
    container_running "$NC_NAME" || { r "$NC_NAME is not running — bring the sandbox up first: $0 up --harp"; exit 1; }
    container_running "$HARP_NAME" || { r "$HARP_NAME is not running — bring the sandbox up first: $0 up --harp"; exit 1; }
    start_front
}

for arg in "$@"; do
    case "$arg" in
        --cloud) CLOUD_MODE=1 ;;
        --harp) HARP=1 ;;
        up|down|clean|logs|status|front) SUBCMD="$arg" ;;
        *) echo "Usage: $0 {up|down|clean|logs|status|front} [--cloud] [--harp]   (env HARP=1 is the same as --harp)"; exit 1 ;;
    esac
done

case "$SUBCMD" in
    up) cmd_up ;;
    down) cmd_down ;;
    clean) cmd_clean ;;
    logs) cmd_logs ;;
    status) cmd_status ;;
    front) cmd_front ;;
esac
