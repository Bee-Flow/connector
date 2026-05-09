#!/usr/bin/env bash
# Local sandbox using AppAPI's `manual-install` daemon (works without
# pushing the image to a public registry).
#
# Subcommands: up | down | clean | logs | status
#
# Env overrides:
#   NC_VERSION=31  NC_PORT=8080  APP_ID=bee_flow_ai
#   IMAGE=bee-flow-connector:dev
#   TENANT_KEY=dev-tenant-key
#   API_BASE_URL=http://host.docker.internal:3101

set -euo pipefail

NC_VERSION="${NC_VERSION:-31}"
NC_PORT="${NC_PORT:-8080}"
APP_ID="${APP_ID:-bee_flow_ai}"
IMAGE="${IMAGE:-bee-flow-connector:dev}"
TENANT_KEY="${TENANT_KEY:-dev-tenant-key}"
API_BASE_URL="${API_BASE_URL:-http://host.docker.internal:3101}"
NC_NAME="bee-flow-nc-sandbox"
CONN_NAME="bee-flow-connector-instance"
DAEMON="manual_dev"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=/var/www/html/data/owncloud.db

g() { printf '\033[1;32m%s\033[0m\n' "$*"; }
b() { printf '\033[1;34m%s\033[0m\n' "$*"; }
r() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

nc_occ() { docker exec -u www-data "$NC_NAME" php occ "$@"; }
nc_sql() { docker exec "$NC_NAME" sqlite3 "$DB" "$1"; }

cmd_up() {
    docker info >/dev/null 2>&1 || { r "Docker daemon is not reachable"; exit 1; }

    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        b "[1/7] Building $IMAGE (one-time, ~1-3 min)"
        # Self-contained build: Dockerfile clones Bee-Flow/hive over a
        # forwarded SSH agent at build time. Context is the connector dir
        # only — no `agent-hub/` sibling required.
        DOCKER_BUILDKIT=1 docker buildx build --ssh default \
            -t "$IMAGE" "$REPO_ROOT/nextcloud-connector"
    else
        b "[1/7] Reusing existing $IMAGE"
    fi

    if ! docker ps --format '{{.Names}}' | grep -qx "$NC_NAME"; then
        if docker ps -a --format '{{.Names}}' | grep -qx "$NC_NAME"; then
            b "[2/7] Starting existing $NC_NAME"
            docker start "$NC_NAME" >/dev/null
        else
            b "[2/7] Launching Nextcloud $NC_VERSION on :$NC_PORT"
            docker run -d --name "$NC_NAME" -p "$NC_PORT:80" \
                --add-host=host.docker.internal:host-gateway \
                "nextcloud:$NC_VERSION" >/dev/null
        fi
    else
        b "[2/7] $NC_NAME already running"
    fi

    b "[3/7] Waiting for apache"
    until docker exec "$NC_NAME" curl -sf http://127.0.0.1/status.php >/dev/null 2>&1; do sleep 2; done

    if ! nc_occ status 2>/dev/null | grep -q 'installed: true'; then
        b "[4/7] Installing Nextcloud (admin/admin)"
        nc_occ maintenance:install --database=sqlite --admin-user=admin --admin-pass=admin >/dev/null
        nc_occ config:system:set trusted_domains 1 --value=host.docker.internal >/dev/null
    else
        b "[4/7] Nextcloud already installed"
    fi

    nc_occ app:install app_api 2>&1 | tail -1 || true
    docker exec "$NC_NAME" bash -c "command -v sqlite3 >/dev/null || (apt-get update -qq >/dev/null && apt-get install -y -qq sqlite3 >/dev/null)" || true

    if ! nc_occ app_api:daemon:list 2>/dev/null | grep -qw "$DAEMON"; then
        b "[5/7] Registering $DAEMON daemon"
        nc_occ app_api:daemon:register \
            "$DAEMON" "Manual Local" manual-install http host.docker.internal "http://host.docker.internal:$NC_PORT" 2>&1 | tail -1
    else
        b "[5/7] Daemon $DAEMON already registered"
    fi

    # Re-register if the ExApp doesn't exist OR if `info.xml` is newer than
    # the registered row (so route/menu changes pick up automatically) OR if
    # FORCE=1 was passed. Otherwise NC's stored routes drift from info.xml
    # silently.
    info_mtime=$(stat -c %Y "$REPO_ROOT/nextcloud-connector/appinfo/info.xml" 2>/dev/null || echo 0)
    db_ctime=$(nc_sql "SELECT created_time FROM oc_ex_apps WHERE appid='$APP_ID';" 2>/dev/null || echo 0)
    if [ -z "$db_ctime" ] || [ "${FORCE:-0}" = "1" ] || [ "$info_mtime" -gt "$db_ctime" ]; then
        b "[6/7] (Re-)registering ExApp $APP_ID (info.xml mtime=$info_mtime, db ctime=$db_ctime)"
        nc_occ app_api:app:disable "$APP_ID" 2>/dev/null | tail -1 || true
        nc_occ app_api:app:unregister "$APP_ID" 2>/dev/null | tail -1 || true
        nc_sql "DELETE FROM oc_ex_apps WHERE appid='$APP_ID'; DELETE FROM oc_ex_apps_routes WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_top_menu WHERE appid='$APP_ID'; DELETE FROM oc_ex_ui_scripts WHERE appid='$APP_ID';" 2>/dev/null || true
        docker cp "$REPO_ROOT/nextcloud-connector/appinfo/info.xml" "$NC_NAME:/tmp/info.xml"
        nc_occ app_api:app:register "$APP_ID" "$DAEMON" \
            --info-xml /tmp/info.xml \
            --env "BEEFLOW_TENANT_KEY=$TENANT_KEY" \
            --env "BEEFLOW_API_BASE_URL=$API_BASE_URL" 2>&1 | tail -1
    else
        b "[6/7] ExApp $APP_ID already registered (info.xml unchanged)"
    fi

    SECRET=$(nc_sql "SELECT secret FROM oc_ex_apps WHERE appid='$APP_ID';")
    PORT=$(nc_sql "SELECT port FROM oc_ex_apps WHERE appid='$APP_ID';")

    docker rm -f "$CONN_NAME" >/dev/null 2>&1 || true
    b "[7/7] Starting connector on :$PORT"
    docker run -d --name "$CONN_NAME" \
        -p "$PORT:$PORT" --add-host=host.docker.internal:host-gateway \
        -e APP_ID="$APP_ID" -e APP_VERSION=0.1.0 \
        -e APP_HOST=0.0.0.0 -e APP_PORT="$PORT" \
        -e APP_SECRET="$SECRET" \
        -e NEXTCLOUD_URL="http://host.docker.internal:$NC_PORT" \
        -e BEEFLOW_TENANT_KEY="$TENANT_KEY" \
        -e BEEFLOW_API_BASE_URL="$API_BASE_URL" \
        "$IMAGE" >/dev/null

    # Wait for the connector's /heartbeat to respond before enabling. Async
    # /init will report progress itself once it boots; we just need the
    # container to be reachable on its assigned port.
    b "[7/7] Waiting for connector /heartbeat on :$PORT"
    for i in $(seq 1 20); do
        if curl -sf -o /dev/null -m 1 "http://localhost:$PORT/heartbeat"; then
            break
        fi
        sleep 0.5
    done

    # Force-bootstrap the deploy state. AppAPI's deploy step (image pull +
    # container start) was bypassed because we ran docker run ourselves;
    # set deploy=100 so AppAPI doesn't think it's mid-install. The /init
    # step will report progress autonomously as the container processes
    # its background setup.
    nc_sql "UPDATE oc_ex_apps SET status='{\"deploy\":100,\"init\":0,\"action\":\"\",\"type\":\"install\",\"error\":\"\"}' WHERE appid='$APP_ID';"
    nc_occ app_api:app:enable "$APP_ID" 2>&1 | tail -1

    g "✔ Sandbox up — http://localhost:$NC_PORT  (admin / admin)"
    echo "  Connector port: $PORT  (heartbeat: http://localhost:$PORT/heartbeat)"
    echo "  Connector logs: docker logs -f $CONN_NAME"
}

cmd_down() {
    docker rm -f "$NC_NAME" "$CONN_NAME" 2>/dev/null && g "✔ stopped" || echo "(nothing to stop)"
}
cmd_clean() {
    cmd_down
    docker rmi "$IMAGE" 2>/dev/null && g "✔ image removed" || true
}
cmd_logs()   { docker logs -f --tail 50 "$CONN_NAME"; }
cmd_status() {
    docker ps --filter "name=$NC_NAME" --filter "name=$CONN_NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    curl -s "http://localhost:$NC_PORT/status.php" | head -c 200; echo
}

case "${1:-up}" in
    up) cmd_up ;;
    down) cmd_down ;;
    clean) cmd_clean ;;
    logs) cmd_logs ;;
    status) cmd_status ;;
    *) echo "Usage: $0 {up|down|clean|logs|status}"; exit 1 ;;
esac
