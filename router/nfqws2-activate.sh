#!/bin/sh
# Explicitly attach panel-managed nfqws2 to Xray; called only after user confirms.
set -eu

ROOT=/opt/etc/xkeen/nfqws2-stage
CONFIG=/opt/etc/xray/configs/00_config.json
MARKER="$ROOT/global-enabled"
JQ=/opt/bin/jq
XRAY=/opt/sbin/xray
XRAY_INIT=/opt/etc/init.d/S05xkeen
NFQWS_INIT=/opt/etc/init.d/S98nfqws2-xkeen

[ -x "$ROOT/engine" ] && [ -x "$ROOT/canary.sh" ] || { echo 'nfqws2 is not installed' >&2; exit 1; }
[ -x "$JQ" ] && [ -x "$XRAY" ] && [ -r "$CONFIG" ] || { echo 'Xray or jq is unavailable' >&2; exit 1; }
if [ -f "$MARKER" ]; then
    echo 'nfqws2 is already attached to Xray'
    exit 0
fi

WORK=$(mktemp -d /opt/tmp/xkeen-nfqws-activate.XXXXXX)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
cp -p "$CONFIG" "$WORK/original.json"
chmod 600 "$WORK/original.json"

if "$JQ" -e 'any(.outbounds[]?; .tag == "nfqws-direct")' "$CONFIG" >/dev/null; then
    "$JQ" -e 'any(.outbounds[]?; .tag == "nfqws-direct" and .protocol == "freedom" and .streamSettings.sockopt.mark == 832)' "$CONFIG" >/dev/null || {
        echo 'nfqws-direct exists with incompatible settings' >&2; exit 1;
    }
    cp -p "$CONFIG" "$WORK/candidate.json"
else
    "$JQ" '.outbounds += [{"tag":"nfqws-direct","protocol":"freedom","settings":{},"streamSettings":{"sockopt":{"domainStrategy":"UseIPv4","mark":832}}}]' "$CONFIG" > "$WORK/candidate.json"
fi
chmod 600 "$WORK/candidate.json"
mkdir "$WORK/check"
cp "$WORK/candidate.json" "$WORK/check/00_config.json"
XRAY_LOCATION_ASSET=/opt/etc/xray/dat "$XRAY" -test -confdir "$WORK/check" >/dev/null 2>&1 || {
    echo 'Xray rejected the proposed configuration' >&2; exit 1;
}

cp -p "$WORK/original.json" "$ROOT/00_config.before-nfqws-$(date +%Y%m%d%H%M%S).json"
cp "$WORK/candidate.json" "$CONFIG.nfqws-new"
chmod 600 "$CONFIG.nfqws-new"
mv "$CONFIG.nfqws-new" "$CONFIG"
touch "$MARKER"
chmod 600 "$MARKER"

if ! "$NFQWS_INIT" start >/dev/null 2>&1 || ! "$XRAY_INIT" restart on >/dev/null 2>&1; then
    rm -f "$MARKER"
    "$NFQWS_INIT" stop >/dev/null 2>&1 || true
    cp -p "$WORK/original.json" "$CONFIG"
    "$XRAY_INIT" restart on >/dev/null 2>&1 || true
    echo 'Activation failed; previous Xray configuration restored' >&2
    exit 1
fi
echo 'nfqws2 direct outbound is available in Xray routing'
