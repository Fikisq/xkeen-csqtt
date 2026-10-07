#!/bin/sh
# Reproducible GPLv3 router build. All project/cache files stay in BUILD_ROOT.
set -eu
ROOT=${1:?Usage: build-wdtt-plus-v20.sh ABSOLUTE_BUILD_ROOT}
case "$ROOT" in /*) ;; *) echo 'Use an absolute build path' >&2; exit 2 ;; esac
PIN=d450e132d2477a80d7079282c200ac3fb97ad0ae
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
mkdir -p "$ROOT"
if [ ! -d "$ROOT/source/.git" ]; then
    git clone --branch v20 --depth 1 https://github.com/Ivan4537/WDTT-Plus.git "$ROOT/source"
fi
[ "$(git -C "$ROOT/source" rev-parse HEAD)" = "$PIN" ] || { echo 'Wrong upstream commit' >&2; exit 1; }
git -C "$ROOT/source" diff --quiet || { echo 'Source is already modified; use a fresh build directory' >&2; exit 1; }
git -C "$ROOT/source" apply "$SCRIPT_DIR/wdtt-plus-client-v20.patch"
mkdir -p "$ROOT/package" "$ROOT/tmp" "$ROOT/go-cache" "$ROOT/go-mod-cache"
export GOCACHE="$ROOT/go-cache" GOMODCACHE="$ROOT/go-mod-cache" GOTMPDIR="$ROOT/tmp"
export GOOS=linux GOARCH=arm64 CGO_ENABLED=0
(cd "$ROOT/source/go_client" && go build -p 2 -trimpath -ldflags='-s -w' -o "$ROOT/package/client" .)
printf 'v20-router.2\n' > "$ROOT/package/client-version"
cp "$ROOT/source/LICENSE" "$ROOT/package/LICENSE.WDTT-Plus"
cp "$SCRIPT_DIR/wdtt-plus-run.sh" "$SCRIPT_DIR/wdtt-plus-watchdog.sh" "$SCRIPT_DIR/wdtt-plus-calls.sh" "$SCRIPT_DIR/S99wdtt-plus" "$ROOT/package/"
(cd "$ROOT/package" && sha256sum client client-version wdtt-plus-run.sh wdtt-plus-watchdog.sh wdtt-plus-calls.sh S99wdtt-plus LICENSE.WDTT-Plus > SHA256SUMS)
echo "Built upstream $PIN with router SOCKS capacity and packet-processing optimizations"
