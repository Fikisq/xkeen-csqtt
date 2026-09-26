#!/bin/sh
# Stop any running A/B round, restore the chunk64 client, show why the start failed.
D=/opt/etc/wdtt-plus
for p in $(ps | grep -E 'ab-all|ab-run' | grep -v grep | awk '{print $1}'); do
    kill "$p" 2>/dev/null
done
sleep 1
/opt/etc/init.d/S99wdtt-plus stop >/dev/null 2>&1
sleep 2
if [ -f "$D/wdtt-plus-client.chunk64" ]; then
    mv "$D/wdtt-plus-client" "$D/wdtt-plus-client.stock"
    mv "$D/wdtt-plus-client.chunk64" "$D/wdtt-plus-client"
    chmod 700 "$D/wdtt-plus-client"
fi
printf 'active client: %s\n' "$(sha256sum "$D/wdtt-plus-client" | cut -c1-16)"
ls -l "$D" | grep client
echo '--- last start attempt'
start=$(grep -n WDTT_PLUS_START "$D/wdtt-plus.log" | tail -1 | cut -d: -f1)
tail -n +"${start:-1}" "$D/wdtt-plus.log" | grep -v 'СТАТИСТИКА' | head -n 30 |
    sed -E 's/[A-Za-z0-9_-]{16,}/<R>/g'
echo '--- manual call files'
ls "$D" | grep vk_manual
echo '--- conf'
grep -E '^(WORKERS|VK_HASH_MODE|VK_HASHES_COUNT|VK_TOKEN_SOURCE|RT_NETWORK)=' "$D/wdtt-plus.conf"
echo '--- service'
/opt/etc/init.d/S99wdtt-plus status
