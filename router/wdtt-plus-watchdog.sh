#!/bin/sh
set -u
DIR=/opt/etc/wdtt-plus
CLIENT_PID=/var/run/wdtt-plus.pid
HEALTH=/var/run/wdtt-plus-health
RESTARTS=/var/run/wdtt-plus-restarts
failures=0

sleep 10
while [ -s "$CLIENT_PID" ] && kill -0 "$(cat "$CLIENT_PID")" 2>/dev/null; do
    if /opt/bin/curl --silent --output /dev/null --fail --ipv4 \
        --socks5 127.0.0.1:1088 --connect-timeout 3 --max-time 6 \
        https://cp.cloudflare.com/ || \
       /opt/bin/curl --silent --output /dev/null --fail --ipv4 \
        --socks5 127.0.0.1:1088 --connect-timeout 3 --max-time 6 \
        https://www.speedtest.net/; then
        date +%s > "$HEALTH"
        failures=0
    else
        rm -f "$HEALTH"
        failures=$((failures + 1))
        echo "WDTT Plus: HTTP через SOCKS5 не отвечает ($failures/3)" >> "$DIR/wdtt-plus.log"
        if [ "$failures" -ge 3 ]; then
            now=$(date +%s)
            first=$(cat "$RESTARTS" 2>/dev/null || echo 0)
            case "$first" in ''|*[!0-9]*) first=0 ;; esac
            if [ "$((now - first))" -ge 3600 ]; then
                printf '%s %s\n' "$now" 0 > "$RESTARTS"
            fi
            count=$(awk '{print $2}' "$RESTARTS" 2>/dev/null)
            case "$count" in ''|*[!0-9]*) count=0 ;; esac
            if [ "$count" -lt 2 ]; then
                printf '%s %s\n' "$(awk '{print $1}' "$RESTARTS")" "$((count + 1))" > "$RESTARTS"
                echo 'WDTT Plus: туннель не отвечает, перезапускаю клиент' >> "$DIR/wdtt-plus.log"
                nohup /opt/etc/init.d/S99wdtt-plus restart >> "$DIR/wdtt-plus.log" 2>&1 &
                exit 0
            fi
            failures=0
            echo 'WDTT Plus: предел 2 перезапуска в час, ожидаю восстановления' >> "$DIR/wdtt-plus.log"
        fi
    fi
    sleep 30
done
rm -f "$HEALTH"
