#!/bin/sh
set -u
umask 077
DIR=/opt/etc/wdtt-plus
CLIENT_PID=/var/run/wdtt-plus.pid
HEALTH=/var/run/wdtt-plus-health
RESTARTS=/var/run/wdtt-plus-restarts
failures=0
ready=0
started_at=$(date +%s)
owns_client_pid() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ -r "/proc/$1/cmdline" ] || return 1
    case "$(tr '\000' ' ' < "/proc/$1/cmdline")" in
        *"$DIR/wdtt-plus-client"*|*"$DIR/wdtt-plus-run.sh"*) return 0 ;;
    esac
    return 1
}

sleep 10
while [ -s "$CLIENT_PID" ] && owns_client_pid "$(cat "$CLIENT_PID")"; do
    [ ! -e "$DIR/stopped" ] || break
    if [ -f "$DIR/wdtt-plus.log" ] && [ "$(wc -c < "$DIR/wdtt-plus.log")" -ge 2097152 ]; then
        if tail -c 1048576 "$DIR/wdtt-plus.log" > "$DIR/wdtt-plus.log.1.tmp"; then
            mv -f "$DIR/wdtt-plus.log.1.tmp" "$DIR/wdtt-plus.log.1"
            : > "$DIR/wdtt-plus.log"
        fi
    fi
    if /opt/bin/curl --silent --output /dev/null --fail --ipv4 \
        --socks5 127.0.0.1:1088 --connect-timeout 3 --max-time 6 \
        https://cp.cloudflare.com/ || \
       /opt/bin/curl --silent --output /dev/null --fail --ipv4 \
        --socks5 127.0.0.1:1088 --connect-timeout 3 --max-time 6 \
        https://www.speedtest.net/; then
        date +%s > "$HEALTH"
        ready=1
        failures=0
    else
        rm -f "$HEALTH"
        if [ "$ready" -eq 0 ] && [ "$(($(date +%s) - started_at))" -lt 240 ]; then
            sleep 30
            continue
        fi
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
                [ ! -e "$DIR/stopped" ] || break
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
