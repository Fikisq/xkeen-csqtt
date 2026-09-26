#!/bin/sh
# Clear orphan client/watchdog/FIFO writers left by an aborted run, then start cleanly.
D=/opt/etc/wdtt-plus
L=$D/wdtt-plus.log
/opt/etc/init.d/S99wdtt-plus stop >/dev/null 2>&1
sleep 2
for pat in wdtt-plus-client wdtt-plus-watchdog wdtt-plus-run startup.fifo; do
    for p in $(ps | grep "$pat" | grep -v grep | awk '{print $1}'); do
        kill -9 "$p" 2>/dev/null
    done
done
sleep 1
rm -f "$D/startup.fifo" /var/run/wdtt-plus.pid /var/run/wdtt-plus-watchdog.pid
echo "orphans cleared; remaining matches: $(ps | grep -c '[w]dtt-plus')"
workers=$(sed -n "s/^WORKERS=['\"]\{0,1\}\([0-9]*\).*/\1/p" "$D/wdtt-plus.conf")
/opt/etc/init.d/S99wdtt-plus start
n=0; act=0
while [ "$n" -lt 120 ]; do
    sleep 3; n=$((n + 3))
    act=$(tail -n 5 "$L" | grep -o 'Активных: [0-9]*' | tail -1 | sed 's/[^0-9]//g')
    [ "${act:-0}" -ge "${workers:-36}" ] && break
done
printf 'after %ss active=%s of %s\n' "$n" "${act:-0}" "${workers:-?}"
printf 'socks egress: %s\n' "$(/opt/bin/curl -s --max-time 12 --socks5-hostname 127.0.0.1:1088 https://api.ipify.org)"
start=$(grep -n WDTT_PLUS_START "$L" | tail -1 | cut -d: -f1)
tail -n +"${start:-1}" "$L" | grep -vE 'СТАТИСТИКА|ВОРКЕР|СЕССИЯ|HEALTH|ДИСП' | head -n 20 |
    sed -E 's/^[0-9\/]+ ([0-9:]+)\.[0-9]+/\1/; s/[A-Za-z0-9_-]{16,}/<R>/g'
/opt/etc/init.d/S99wdtt-plus status
