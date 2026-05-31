#!/usr/bin/env bash
#
# aio-trust-local-cert.sh — make a LOCAL Nextcloud All-in-One (AIO) trust a
# self-signed / internal-CA TLS certificate, so ExApps (incl. Bee Flow) load
# their embedded UI for local testing.
#
# The problem (local testing only)
# ────────────────────────────────
# On AIO, several components call Nextcloud over HTTPS and verify the TLS cert.
# With a self-signed / internal-CA cert (Caddy `tls internal`, *.nip.io, mkcert),
# those calls fail ("certificate verify failed") and every ExApp browser request
# returns HTTP 500 — the app icon shows but clicking it is blank. Three hops must
# trust the cert; this script fixes the two that are AIO's responsibility:
#
#   1. Bee Flow connector → Nextcloud   — handled automatically by the connector.
#   2. HaRP → Nextcloud                 — FIXED HERE (read-only container, so we
#                                          recreate it with SSL_CERT_FILE pointed
#                                          at a CA bundle in its /certs volume).
#   3. Nextcloud PHP → its own URL      — FIXED HERE (CA added to the NC
#                                          container's writable trust store).
#
# On a PRODUCTION Nextcloud with a valid (publicly-trusted) certificate none of
# this is needed — every component trusts it already and the released connector
# "just works". This script is a LOCAL-TESTING convenience and changes only the
# Nextcloud/HaRP side, never the connector.
#
# Caveats
# ───────
# • It recreates the `nextcloud-aio-harp` container (recoverable: restart the
#   containers from the AIO interface and AIO rebuilds HaRP fresh).
# • An AIO/Nextcloud update recreates HaRP + NC from stock and drops these
#   changes — just re-run this script if the embedded app goes blank again.
#
# Usage:  ./aio-trust-local-cert.sh [options]
#   --ca <file>    Nextcloud root CA (PEM). Default: auto-detect mkcert, then a
#                  Caddy container's `tls internal` root.
#   --harp <name>  HaRP container (default: nextcloud-aio-harp).
#   --nc <name>    Nextcloud container (default: nextcloud-aio-nextcloud).
#   --caddy <name> Caddy container to read the root from (default: auto-detect).
#   --app-id <id>  ExApp id to verify afterwards (default: bee_flow).
#   --nc-url <url> Nextcloud base URL for verification (default: HaRP's NC_INSTANCE_URL).
#   -h, --help     Show this help.
#
set -euo pipefail

HARP_CONTAINER="nextcloud-aio-harp"
NC_CONTAINER="nextcloud-aio-nextcloud"
CADDY_CONTAINER=""
CA_FILE=""
APP_ID="bee_flow"
NC_URL=""
BUNDLE_PATH="/certs/nc-ca-bundle.pem"

log()  { printf '\033[1;34m[trust]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[trust]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[trust] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ca)      CA_FILE="${2:-}"; shift 2 ;;
        --harp)    HARP_CONTAINER="${2:-}"; shift 2 ;;
        --nc)      NC_CONTAINER="${2:-}"; shift 2 ;;
        --caddy)   CADDY_CONTAINER="${2:-}"; shift 2 ;;
        --app-id)  APP_ID="${2:-}"; shift 2 ;;
        --nc-url)  NC_URL="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,55p' "$0"; exit 0 ;;
        *)         die "unknown option: $1 (try --help)" ;;
    esac
done

# Run docker on the host even from inside a VS Code Flatpak sandbox.
if [ -e /.flatpak-info ] && command -v flatpak-spawn >/dev/null 2>&1; then
    docker() { flatpak-spawn --host docker "$@"; }
fi
docker version >/dev/null 2>&1 || die "cannot reach the Docker daemon"
docker inspect "$HARP_CONTAINER" >/dev/null 2>&1 || die "HaRP container '$HARP_CONTAINER' not found (pass --harp). Is this a Nextcloud AIO host with AppAPI+HaRP?"
docker inspect "$NC_CONTAINER"   >/dev/null 2>&1 || die "Nextcloud container '$NC_CONTAINER' not found (pass --nc)."

# ── 1. Obtain the Nextcloud root CA (PEM) ─────────────────────────────────────
TMP_CA="$(mktemp)"; trap 'rm -f "$TMP_CA"' EXIT
if [ -n "$CA_FILE" ]; then
    [ -f "$CA_FILE" ] || die "--ca file not found: $CA_FILE"
    cp "$CA_FILE" "$TMP_CA"; log "using CA from --ca: $CA_FILE"
elif command -v mkcert >/dev/null 2>&1 && [ -f "$(mkcert -CAROOT 2>/dev/null)/rootCA.pem" ]; then
    cp "$(mkcert -CAROOT)/rootCA.pem" "$TMP_CA"; log "using mkcert root CA"
else
    if [ -z "$CADDY_CONTAINER" ]; then
        for c in aio-caddy caddy nextcloud-aio-caddy; do
            docker inspect "$c" >/dev/null 2>&1 && { CADDY_CONTAINER="$c"; break; }
        done
    fi
    [ -n "$CADDY_CONTAINER" ] || die "could not auto-detect a CA source. Pass --ca <root-ca.pem>."
    docker exec "$CADDY_CONTAINER" sh -c 'cat /data/caddy/pki/authorities/local/root.crt' > "$TMP_CA" 2>/dev/null \
        || die "could not read Caddy internal root from '$CADDY_CONTAINER'. Pass --ca <file>."
    log "using Caddy 'tls internal' root CA from container '$CADDY_CONTAINER'"
fi
grep -q "BEGIN CERTIFICATE" "$TMP_CA" || die "the CA file is not a PEM certificate"

# ── 2. Hop 3 — trust the cert in the Nextcloud container (writable rootfs) ────
log "adding CA to Nextcloud container '$NC_CONTAINER' trust store…"
docker exec -i "$NC_CONTAINER" sh -c 'mkdir -p /usr/local/share/ca-certificates && cat > /usr/local/share/ca-certificates/nc-local-ca.crt' < "$TMP_CA"
docker exec "$NC_CONTAINER" sh -c 'command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1' \
    || warn "update-ca-certificates not found in '$NC_CONTAINER'; PHP may still distrust the cert"
log "Nextcloud now trusts the local cert."

# ── 3. Hop 2 — trust the cert in HaRP (read-only rootfs → SSL_CERT_FILE) ──────
log "building HaRP trust bundle (system roots + NC CA) in its /certs volume…"
docker exec -i "$HARP_CONTAINER" sh -c "cat /etc/ssl/cert.pem - > '$BUNDLE_PATH'" < "$TMP_CA" \
    || die "failed to write the bundle into HaRP's /certs volume"

log "capturing HaRP config and recreating it with SSL_CERT_FILE…"
IMAGE="$(docker inspect "$HARP_CONTAINER" --format '{{.Config.Image}}')"
mapfile -t ENV_LINES   < <(docker inspect "$HARP_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
mapfile -t LABEL_LINES < <(docker inspect "$HARP_CONTAINER" --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}')
RUN_ARGS=( -d --name "$HARP_CONTAINER" --network nextcloud-aio --restart unless-stopped
           --read-only --tmpfs /run/harp --tmpfs /tmp --user root --workdir /var/lib/haproxy
           -v /var/run/docker.sock:/var/run/docker.sock:ro -v nextcloud_aio_harp:/certs )
for e in "${ENV_LINES[@]}";   do [ -n "$e" ] && RUN_ARGS+=( -e "$e" ); done
RUN_ARGS+=( -e "SSL_CERT_FILE=$BUNDLE_PATH" )
for l in "${LABEL_LINES[@]}"; do [ -n "$l" ] && RUN_ARGS+=( --label "$l" ); done

warn "recreating '$HARP_CONTAINER' (recoverable: restart AIO to undo)…"
docker rm -f "$HARP_CONTAINER" >/dev/null
docker run "${RUN_ARGS[@]}" "$IMAGE" >/dev/null
log "HaRP recreated with the local cert trusted."

# ── 4. Verify the browser-proxy end-to-end ───────────────────────────────────
[ -z "$NC_URL" ] && NC_URL="$(docker exec "$HARP_CONTAINER" sh -c 'printf %s "$NC_INSTANCE_URL"' 2>/dev/null || true)"
if [ -z "$NC_URL" ]; then
    warn "could not determine the Nextcloud URL; open NC and click the app icon — it should now load."
    exit 0
fi
PROXY_URL="${NC_URL%/}/index.php/apps/app_api/proxy/${APP_ID}/heartbeat"
log "verifying ${PROXY_URL} …"
code=000
for _ in $(seq 1 25); do
    code="$(docker exec "$NC_CONTAINER" sh -c "curl -sk -o /dev/null -w '%{http_code}' --max-time 5 '$PROXY_URL'" 2>/dev/null || true)"
    [ -z "$code" ] && code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$PROXY_URL" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && break
    sleep 2
done

echo
if [ "$code" = "200" ]; then
    log "✅ Browser-proxy returns 200 — the embedded Bee Flow app should now load (hard-refresh your browser)."
else
    warn "browser-proxy still returns HTTP $code."
    warn "  • Verify the CA actually signs your Nextcloud cert (the --ca / auto-detected one)."
    warn "  • HaRP SSL: docker logs $HARP_CONTAINER | grep -i ssl    NC SSL: docker exec $NC_CONTAINER curl -sv https://<your-nc>/status.php"
    warn "  • To undo: restart the containers from the AIO interface."
    exit 1
fi
log "NOTE: an AIO/Nextcloud update recreates these containers from stock and drops the change — re-run this script then."
