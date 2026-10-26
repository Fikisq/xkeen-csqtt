#!/bin/sh
# Package only public starter configuration and the panel-compatible init script.
set -eu
out=${1:-xkeen-bootstrap-arm64-v8a.tar.gz}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cp router/S05xkeen-device-priority.sh "$work/S05xkeen"
cp router/initial-config.json "$work/00_config.json"
cp backend/src/mihomo-starter.yaml "$work/mihomo-config.yaml"
cp router/LICENSE-XKeen "$work/LICENSE-XKeen"
chmod 755 "$work/S05xkeen"
tar -czf "$out" -C "$work" .
