#!/usr/bin/env bash
# Local sandbox for the Bee Flow Nextcloud connector.
#
# Spins up a fresh Nextcloud container with AppAPI installed, registers a
# local Docker deploy daemon, builds the connector image, and side-loads it.
# All against your real local Docker — no certs, no App Store account needed.
#
# Subcommands:
#   up       Build image, start NC, install AppAPI, register connector
#   down     Stop and remove the NC container (keeps the image)
#   clean    down + remove image + remove the connector container if any
#   logs     Tail Nextcloud + connector logs
#   shell    Open an occ shell inside the NC container
#   status   Show what's running and connector heartbeat
#
# Env overrides:
#   NC_VERSION       Nextcloud image tag (default: 31)
#   NC_PORT          Host port for Nextcloud UI (default: 8080)
#   APP_ID           App ID (default: bee_flow_ai)
#   IMAGE            Connector image name (default: bee-flow-connector:dev)
#   TENANT_KEY       BEEFLOW_TENANT_KEY value (default: dev-tenant-key)
#   API_BASE_URL     BEEFLOW_API_BASE_URL (default: http://host.docker.internal:3101)

set -euo pipefail

NC_VERSION="${NC_VERSION:-31}"
NC_PORT="${NC_PORT:-8080}"
APP_ID="${APP_ID:-bee_flow_ai}"
IMAGE="${IMAGE:-bee-flow-connector:dev}"
TENANT_KEY="${TENANT_KEY:-dev-tenant-key}"
API_BASE_URL="${API_BASE_URL:-http://host.docker.internal:3101}"
NC_NAME="bee-flow-nc-sandbox"
DAEMON_NAME="docker_local"
ADMIN_USER="admin"
ADMIN_PASS="admin"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONNECTOR_DIR="$REPO_ROOT/nextcloud-connector"

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

require_docker() {
    command -v docker >/dev/null || { c_red "docker not found in PATH"; exit 1; }
    docker info >/dev/null 2>&1 || { c_red "Docker daemon is not reachable"; exit 1; }
}

nc_exec() {
    docker exec -u www-data "$NC_NAME" php occ "$@"
}

wait_for_nc() {
    c_blue "[wait] Nextcloud install (this is slow on first boot)…"
    for i in {1..120}; do
        if docker exec -u www-data "$NC_NAME" php occ status 2>/dev/null | grep -q 'installed: true'; then
            c_green "[wait] Nextcloud ready"
            return 0
        fi
        sleep 2
    done
    c_red "[wait] Nextcloud did not become ready in 240s"
    docker logs --tail 50 "$NC_NAME" >&2
    exit 1
}

cmd_up() {
    require_docker

    c_blue "[1/6] Building connector image $IMAGE from $REPO_ROOT"
    docker build -f "$CONNECTOR_DIR/Dockerfile" -t "$IMAGE" "$REPO_ROOT"

    if docker ps -a --format '{{.Names}}' | grep -qx "$NC_NAME"; then
        c_blue "[2/6] Reusing existing $NC_NAME container"
        docker start "$NC_NAME" >/dev/null
    else
        c_blue "[2/6] Starting Nextcloud $NC_VERSION on :$NC_PORT"
        docker run -d --name "$NC_NAME" \
            -p "$NC_PORT:80" \
            -e NEXTCLOUD_ADMIN_USER="$ADMIN_USER" \
            -e NEXTCLOUD_ADMIN_PASSWORD="$ADMIN_PASS" \
            -e NEXTCLOUD_TRUSTED_DOMAINS="localhost host.docker.internal" \
            --add-host=host.docker.internal:host-gateway \
            -v /var/run/docker.sock:/var/run/docker.sock \
            "nextcloud:$NC_VERSION" >/dev/null
    fi
    wait_for_nc

    c_blue "[3/6] Installing app_api"
    nc_exec app:install app_api 2>/dev/null || nc_exec app:enable app_api

    c_blue "[4/6] Registering local Docker deploy daemon: $DAEMON_NAME"
    if nc_exec app_api:daemon:list 2>/dev/null | grep -q "\"name\": \"$DAEMON_NAME\""; then
        echo "      (already registered)"
    else
        nc_exec app_api:daemon:register \
            --net host \
            "$DAEMON_NAME" "Local Docker" docker-install \
            http host.docker.internal "http://host.docker.internal:$NC_PORT" \
            || c_red "(daemon register failed — see error above)"
    fi

    c_blue "[5/6] Side-loading $APP_ID from $CONNECTOR_DIR/appinfo/info.xml"
    docker cp "$CONNECTOR_DIR/appinfo/info.xml" "$NC_NAME:/tmp/info.xml"
    if nc_exec app_api:app:list 2>/dev/null | grep -q "\"$APP_ID\""; then
        echo "      already registered — unregister first to reload manifest"
    else
        nc_exec app_api:app:register "$APP_ID" "$DAEMON_NAME" \
            --info-xml /tmp/info.xml \
            --env "BEEFLOW_TENANT_KEY=$TENANT_KEY" \
            --env "BEEFLOW_API_BASE_URL=$API_BASE_URL" \
            || c_red "(register failed — check 'docker logs $NC_NAME')"
    fi

    c_blue "[6/6] Setting tenant config"
    nc_exec app_api:app:setenv "$APP_ID" BEEFLOW_TENANT_KEY "$TENANT_KEY" || true
    nc_exec app_api:app:setenv "$APP_ID" BEEFLOW_API_BASE_URL "$API_BASE_URL" || true

    c_green "✔ Sandbox ready"
    echo
    echo "  Nextcloud:  http://localhost:$NC_PORT  ($ADMIN_USER / $ADMIN_PASS)"
    echo "  App ID:     $APP_ID"
    echo "  SaaS target: $API_BASE_URL"
    echo
    echo "  Logs:    $0 logs"
    echo "  Stop:    $0 down"
    echo "  Reset:   $0 clean"
}

cmd_down() {
    require_docker
    docker rm -f "$NC_NAME" >/dev/null 2>&1 && c_green "✔ Removed $NC_NAME" || echo "(no $NC_NAME to remove)"
    # AppAPI spawns the connector as its own container with a generated name.
    docker ps -a --filter "label=AppAPI=$APP_ID" -q | xargs -r docker rm -f >/dev/null 2>&1 || true
}

cmd_clean() {
    cmd_down
    docker rmi "$IMAGE" >/dev/null 2>&1 && c_green "✔ Removed image $IMAGE" || echo "(no image to remove)"
}

cmd_logs() {
    require_docker
    docker logs -f --tail 50 "$NC_NAME"
}

cmd_shell() {
    require_docker
    docker exec -it -u www-data "$NC_NAME" bash
}

cmd_status() {
    require_docker
    echo "── containers ──"
    docker ps --filter "name=$NC_NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    docker ps --filter "label=AppAPI" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    echo "── connector heartbeat ──"
    if connector=$(docker ps --filter "label=AppAPI=$APP_ID" --format '{{.Names}}' | head -1); then
        if [ -n "$connector" ]; then
            docker exec "$connector" wget -qO- http://127.0.0.1:8080/heartbeat || echo "(no response)"
        else
            echo "(connector container not running)"
        fi
    fi
}

case "${1:-}" in
    up)     cmd_up ;;
    down)   cmd_down ;;
    clean)  cmd_clean ;;
    logs)   cmd_logs ;;
    shell)  cmd_shell ;;
    status) cmd_status ;;
    *)
        cat <<EOF
Usage: $0 {up|down|clean|logs|shell|status}

  up      Build + start NC + install AppAPI + register connector
  down    Stop and remove the NC sandbox container
  clean   down + remove the connector image
  logs    Tail Nextcloud logs
  shell   Open a shell inside the NC container
  status  Show running containers and connector heartbeat
EOF
        exit 1
        ;;
esac
