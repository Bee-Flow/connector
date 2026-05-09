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
    frpc -c /tmp/frpc.toml &
fi

exec "$@"
