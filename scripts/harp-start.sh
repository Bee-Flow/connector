#!/bin/bash
# Bee Flow connector entrypoint — wraps the Node app with optional FRP client
# for HaRP integration.
#
# Mirrors nextcloud/HaRP's example_start.sh: when HP_SHARED_KEY is set,
# write /frpc.toml that exposes Bee Flow's Unix socket back through HaRP's
# FRP tunnel. Otherwise (manual-install daemon) skip frpc and run the
# connector on its TCP port directly.

set -e

if [ -n "$HP_SHARED_KEY" ]; then
    # HaRP / AppAPI may drop a private CA into the container when Nextcloud is
    # reached over HTTPS with a non-public CA. Node's fetch (used for all
    # outbound NC calls in bootstrap.js / heartbeat.js / ncProxy.js) does NOT
    # read the OS trust store for *added* CAs unless told via NODE_EXTRA_CA_CERTS.
    # Fold any mounted CA into the system bundle and point Node at it. No-op when
    # nothing is mounted or NC is reached over plain HTTP internally.
    if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then
        update-ca-certificates 2>/dev/null || true
    fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
        export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
    fi

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
