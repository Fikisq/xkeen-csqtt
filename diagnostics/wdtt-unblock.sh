#!/bin/sh
# Park the unfinishable VK call list so WDTT Plus can start again.
D=/opt/etc/wdtt-plus
if [ -f "$D/vk_api_calls" ]; then
    mv "$D/vk_api_calls" "$D/vk_api_calls.stale-20260926"
    echo 'parked vk_api_calls -> vk_api_calls.stale-20260926'
fi
workers=$(sed -n "s/^WORKERS=['\"]\{0,1\}\([0-9]*\).*/\1/p" "$D/wdtt-plus.conf")
echo "configured workers: ${workers:-?}"
/opt/etc/init.d/S99wdtt-plus start
n=0
while [ "$n" -lt 150 ]; do
    sleep 3; n=$((n + 3))
    act=$(tail -n 5 "$D/wdtt-plus.log" | grep -o 'Активных: [0-9]*' | tail -1 | sed 's/[^0-9]//g')
    [ "${act:-0}" -ge "${workers:-36}" ] && break
done
printf 'after %ss active=%s\n' "$n" "${act:-0}"
grep -E 'Распределение потоков|без восстановления|ANON_BLOCKED' "$D/wdtt-plus.log" | tail -3 |
    sed -E 's/^[0-9\/]+ ([0-9:]+)\.[0-9]+/\1/; s/[A-Za-z0-9_-]{16,}/<R>/g'
printf 'socks egress: %s\n' "$(/opt/bin/curl -s --max-time 12 --socks5-hostname 127.0.0.1:1088 https://api.ipify.org)"
printf 'new vk_api_calls: %s\n' "$([ -f "$D/vk_api_calls" ] && grep -c . "$D/vk_api_calls" || echo absent)"
/opt/etc/init.d/S99wdtt-plus status
