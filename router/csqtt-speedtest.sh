#!/bin/sh
# Measure the router's CSQTT tunnel without changing Xray routing or client devices.
set -eu

IFACE=csqtt0
CURL=/opt/bin/curl
ENDPOINT=https://speed.cloudflare.com
STREAMS=12

fail() { printf 'CSQTT speedtest: %s\n' "$*" >&2; exit 1; }
[ -x "$CURL" ] || fail 'curl is not installed'
[ -r "/sys/class/net/$IFACE/statistics/rx_bytes" ] || fail 'CSQTT is stopped'
/opt/sbin/ip -4 addr show dev "$IFACE" | grep -q 'inet ' || fail 'CSQTT has no tunnel address'

TMP=$(mktemp -d /tmp/csqtt-speedtest.XXXXXX) || fail 'cannot create temporary directory'
cleanup() { rm -f "$TMP"/*; rmdir "$TMP"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

tx_drops_before=$(cat "/sys/class/net/$IFACE/statistics/tx_dropped")
rx_drops_before=$(cat "/sys/class/net/$IFACE/statistics/rx_dropped")

now() { awk '{ print $1 }' /proc/uptime; }
counter() { cat "/sys/class/net/$IFACE/statistics/$1"; }
mbps() { awk -v bytes="$1" -v seconds="$2" 'BEGIN { if (seconds <= 0) exit 1; printf "%.2f", bytes * 8 / 1000000 / seconds }'; }

download() {
    "$CURL" --ipv4 --noproxy '*' --interface "$IFACE" --http1.1 \
        --silent --show-error --fail --connect-timeout 8 --max-time 35 \
        --output /dev/null --write-out '%{http_code} %{size_download} %{time_total}\n' \
        "$ENDPOINT/__down?bytes=$1"
}

upload() {
    "$CURL" --ipv4 --noproxy '*' --interface "$IFACE" --http1.1 \
        --silent --show-error --fail --connect-timeout 8 --max-time 35 \
        --output /dev/null --write-out '%{http_code} %{size_upload} %{time_total}\n' \
        --header 'Content-Type: application/octet-stream' \
        --data-binary "@$2" "$ENDPOINT/__up"
}

# A short probe chooses a payload that takes a few seconds at the current speed.
download 1000000 > "$TMP/warm-down" || fail 'download probe failed'
read -r code bytes seconds < "$TMP/warm-down"
[ "$code" = 200 ] && [ "$bytes" -ge 1000000 ] || fail 'download probe returned incomplete data'
down_probe=$(mbps "$bytes" "$seconds")
down_mb=$(awk -v rate="$down_probe" 'BEGIN { if (rate < 4) print 1; else if (rate < 25) print 3; else if (rate < 60) print 5; else print 10 }')
down_bytes=$((down_mb * 1000000))

rx_before=$(counter rx_bytes)
down_started=$(now)
pids=''
for n in $(seq 1 "$STREAMS"); do
    download "$down_bytes" > "$TMP/down-$n" 2> "$TMP/down-error-$n" &
    pids="$pids $!"
done
for pid in $pids; do wait "$pid" || true; done
down_elapsed=$(awk -v start="$down_started" -v end="$(now)" 'BEGIN { print end - start }')
rx_delta=$(( $(counter rx_bytes) - rx_before ))
down_total=0
down_ok=0
for n in $(seq 1 "$STREAMS"); do
    if read -r code bytes seconds < "$TMP/down-$n"; then
        case "$bytes" in ''|*[!0-9]*) continue ;; esac
        if [ "$code" = 200 ] && [ "$bytes" -ge "$down_bytes" ]; then
            down_total=$((down_total + bytes))
            down_ok=$((down_ok + 1))
        fi
    fi
done
[ "$down_ok" -ge $((STREAMS / 2)) ] || fail 'too many download connections failed'
[ "$rx_delta" -ge $((down_total * 8 / 10)) ] || fail 'download did not pass through csqtt0'
down_rate=$(mbps "$down_total" "$down_elapsed")

dd if=/dev/zero of="$TMP/payload" bs=1000000 count=1 2>/dev/null || fail 'cannot create upload data'
upload 1000000 "$TMP/payload" > "$TMP/warm-up" || fail 'upload probe failed'
read -r code bytes seconds < "$TMP/warm-up"
[ "$code" = 200 ] && [ "$bytes" -ge 1000000 ] || fail 'upload probe returned an error'
up_probe=$(mbps "$bytes" "$seconds")
up_mb=$(awk -v rate="$up_probe" 'BEGIN { if (rate < 12) print 1; else if (rate < 45) print 3; else print 10 }')
dd if=/dev/zero of="$TMP/payload" bs=1000000 count="$up_mb" 2>/dev/null || fail 'cannot create upload data'
up_bytes=$((up_mb * 1000000))

tx_before=$(counter tx_bytes)
up_started=$(now)
pids=''
for n in $(seq 1 "$STREAMS"); do
    upload "$up_bytes" "$TMP/payload" > "$TMP/up-$n" 2> "$TMP/up-error-$n" &
    pids="$pids $!"
done
for pid in $pids; do wait "$pid" || true; done
up_elapsed=$(awk -v start="$up_started" -v end="$(now)" 'BEGIN { print end - start }')
tx_delta=$(( $(counter tx_bytes) - tx_before ))
up_total=0
up_ok=0
for n in $(seq 1 "$STREAMS"); do
    if read -r code bytes seconds < "$TMP/up-$n"; then
        case "$bytes" in ''|*[!0-9]*) continue ;; esac
        if [ "$code" = 200 ] && [ "$bytes" -ge "$up_bytes" ]; then
            up_total=$((up_total + bytes))
            up_ok=$((up_ok + 1))
        fi
    fi
done
[ "$up_ok" -ge $((STREAMS / 2)) ] || fail 'too many upload connections failed'
[ "$tx_delta" -ge $((up_total * 8 / 10)) ] || fail 'upload did not pass through csqtt0'
up_rate=$(mbps "$up_total" "$up_elapsed")
tx_drops=$(( $(counter tx_dropped) - tx_drops_before ))
rx_drops=$(( $(counter rx_dropped) - rx_drops_before ))

printf '{"downloadMbps":%s,"uploadMbps":%s,"downloadBytes":%s,"uploadBytes":%s,"downloadStreams":%s,"uploadStreams":%s,"streams":%s,"txDropped":%s,"rxDropped":%s,"interface":"%s","endpoint":"Cloudflare"}\n' \
    "$down_rate" "$up_rate" "$down_total" "$up_total" "$down_ok" "$up_ok" "$STREAMS" "$tx_drops" "$rx_drops" "$IFACE"
