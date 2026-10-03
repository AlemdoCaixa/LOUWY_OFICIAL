#!/bin/sh
set -eu
mkdir -p /run/dbus /var/lib/cloudflare-warp
dbus-uuidgen --ensure=/etc/machine-id
rm -f /run/dbus/pid
dbus-daemon --system --fork
/usr/bin/warp-svc &
warp_pid=$!
proxy_pid=""
stop() { [ -z "$proxy_pid" ] || kill "$proxy_pid" 2>/dev/null || true; kill "$warp_pid" 2>/dev/null || true; }
trap stop INT TERM EXIT
until warp-cli --accept-tos status >/dev/null 2>&1; do
    kill -0 "$warp_pid" || exit 1
    sleep 1
done
# The network changes stay inside this container. Registration is provisioned
# once in the private persistent volume, never in the image or repository.
warp-cli --accept-tos mode warp
warp-cli --accept-tos tunnel protocol set WireGuard
warp-cli --accept-tos connect
while kill -0 "$warp_pid" 2>/dev/null; do
    if warp-cli --accept-tos status 2>/dev/null | grep -q 'Status update: Connected'; then
        if [ -z "$proxy_pid" ] || ! kill -0 "$proxy_pid" 2>/dev/null; then
            microsocks -i 0.0.0.0 -p 40001 &
            proxy_pid=$!
        fi
    elif [ -n "$proxy_pid" ]; then
        kill "$proxy_pid" 2>/dev/null || true
        wait "$proxy_pid" 2>/dev/null || true
        proxy_pid=""
    fi
    sleep 3
done
exit 1
