#!/bin/bash
# Bee Flow connector entrypoint — wraps the Node app with optional FRP client
# for HaRP integration.
#
# Mirrors nextcloud/HaRP's example_start.sh: when HP_SHARED_KEY is set,
# write /frpc.toml that exposes Bee Flow's Unix socket back through HaRP's
# FRP tunnel. Otherwise (manual-install daemon) skip frpc and run the
# connector on its TCP port directly.

set -e

# Decide the Nextcloud TLS posture before the connector makes any NC call.
# Runs in ALL deploy modes (manual-install, HaRP FRP-tunnel, HaRP exapp_direct)
# — Node's fetch (bootstrap.js / heartbeat.js / ncProxy.js) ignores the OS trust
# store, so a self-signed / internal-CA Nextcloud would otherwise fail every
# call and the app's top-bar icon would never register. ncTlsTrust.js does a
# strict handshake first and only flags a relaxed posture when the cert does NOT
# already verify; src/ncTls.js then applies it scoped to the Nextcloud origin
# only, so valid public certs and the Bee Flow server channel keep full
# verification. Never fatal: a failure here must not stop the connector booting.
node /app/src/ncTlsTrust.js || echo "[harp-start] nc-tls-trust skipped (non-fatal)" >&2
for _ncenv in "${APP_PERSISTENT_STORAGE:-/data}/nc-trust/env" /tmp/nc-trust/env; do
    if [ -f "$_ncenv" ]; then
        # Auto-export every KEY=VALUE the helper wrote (BEEFLOW_NC_TLS_INSECURE
        # or BEEFLOW_NC_CA_FILE) so src/ncTls.js sees them.
        set -a
        # shellcheck disable=SC1090
        . "$_ncenv"
        set +a
        echo "[harp-start] applied NC TLS posture from $_ncenv" >&2
        break
    fi
done

if [ -n "$HP_SHARED_KEY" ]; then
    if [ -d "/certs/frp" ]; then
        cat > /tmp/frpc.toml <<EOF
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = true
transport.tls.certFile = "/certs/frp/client.crt"
transport.tls.keyFile = "/certs/frp/client.key"
transport.tls.trustedCaFile = "/certs/frp/ca.crt"
transport.tls.serverName = "harp.nc"

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
remotePort = $APP_PORT
type = "tcp"
name = "$APP_ID"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "/tmp/exapp.sock"
EOF
    else
        cat > /tmp/frpc.toml <<EOF
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = false

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
remotePort = $APP_PORT
type = "tcp"
name = "$APP_ID"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "/tmp/exapp.sock"
EOF
    fi
    echo "[harp-start] launching frpc → ${HP_FRP_ADDRESS}:${HP_FRP_PORT}"
    # Supervise frpc: if it crashes, the Node app stays up and the container
    # still reports "healthy" (the healthcheck probes the local socket, not the
    # tunnel), but it would be unreachable through HaRP. Restart on exit so the
    # tunnel self-heals. loginFailExit=false already covers transient login
    # failures; this covers hard crashes. Operators: grep logs for "frpc exited".
    (
        while true; do
            frpc -c /tmp/frpc.toml
            echo "[harp-start] frpc exited ($?) — restarting in 2s" >&2
            sleep 2
        done
    ) &
fi

exec "$@"
