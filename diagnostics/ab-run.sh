#!/bin/sh
# One measurement round for the currently installed WDTT Plus client.
set -u
D=/opt/etc/wdtt-plus
L=$D/wdtt-plus.log
URL=https://proof.ovh.net/files/1Gb.dat
SECS=10
label=$1
mark=$(wc -l < "$L")
/opt/etc/init.d/S99wdtt-plus start >/dev/null 2>&1
n=0; act=0
while [ "$n" -lt 150 ]; do
    sleep 3; n=$((n + 3))
    act=$(tail -n 5 "$L" | grep -o 'Активных: [0-9]*' | tail -1 | sed 's/[^0-9]//g')
    [ "${act:-0}" -ge 72 ] && break
done
sleep 5
egress=$(/opt/bin/curl -s --max-time 12 --socks5-hostname 127.0.0.1:1088 https://api.ipify.org)
one=$(/opt/bin/curl -s --socks5-hostname 127.0.0.1:1088 -o /dev/null \
    --max-time "$SECS" -w '%{size_download}' "$URL")
single=$(awk -v b="${one:-0}" -v s="$SECS" 'BEGIN{printf "%.1f", b*8/s/1e6}')
T=$(mktemp -d /tmp/xk-ab.XXXXXX)
for i in 1 2 3 4; do
    /opt/bin/curl -s --socks5-hostname 127.0.0.1:1088 -o /dev/null \
        --max-time "$SECS" -w '%{size_download}\n' "$URL" > "$T/d$i" &
done
wait
tot=$(cat "$T"/d1 "$T"/d2 "$T"/d3 "$T"/d4 | awk '{s+=$1} END {print s+0}')
quad=$(awk -v b="$tot" -v s="$SECS" 'BEGIN{printf "%.1f", b*8/s/1e6}')
rm -rf "$T"
act2=$(tail -n 5 "$L" | grep -o 'Активных: [0-9]*' | tail -1 | sed 's/[^0-9]//g')
drops=$(tail -n +"$mark" "$L" | grep -c 'отброшено пакетов')
blocked=$(tail -n +"$mark" "$L" | grep -c 'без восстановления')
dist=$(tail -n +"$mark" "$L" | grep 'Распределение потоков' | tail -1 | sed -E 's/^.*хешам: //')
printf '%-10s ready=%3ss workers=%s/%s  single=%6s Mbit/s  4x=%7s Mbit/s  egress=%s  droplog=%s blockedgroups=%s dist=%s\n' \
    "$label" "$n" "${act:-0}" "${act2:-0}" "$single" "$quad" "${egress:-FAIL}" "$drops" "$blocked" "$dist"
/opt/etc/init.d/S99wdtt-plus stop >/dev/null 2>&1
sleep 3
