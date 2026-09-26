#!/bin/sh
D=/opt/etc/wdtt-plus
echo '--- resolv.conf'
cat /etc/resolv.conf 2>/dev/null | head -5
echo '--- resolve api.vk.ru'
nslookup api.vk.ru 2>&1 | tail -4
echo '--- direct https to VK (no secrets)'
/opt/bin/curl -s -o /dev/null --max-time 12 -w 'curl rc=%{http_code} time=%{time_total}s\n' https://api.vk.ru/method/utils.getServerTime || echo "curl failed rc=$?"
echo '--- WAN'
/opt/bin/curl -s --max-time 10 https://api.ipify.org; echo
echo '--- call files'
for f in vk_api_calls vk_api_calls.stale-20260926; do
    if [ -f "$D/$f" ]; then
        printf '%s: %s ids, mtime %s\n' "$f" "$(grep -c . "$D/$f")" "$(date -r "$D/$f" '+%F %T')"
    else
        printf '%s: absent\n' "$f"
    fi
done
echo '--- xray still fine'
pidof xray
