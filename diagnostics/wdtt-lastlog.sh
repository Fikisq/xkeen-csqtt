#!/bin/sh
D=/opt/etc/wdtt-plus
L=$D/wdtt-plus.log
start=$(grep -n WDTT_PLUS_START "$L" | tail -1 | cut -d: -f1)
echo "last start at line ${start:-?} of $(wc -l < "$L")"
tail -n +"${start:-1}" "$L" | grep -v 'СТАТИСТИКА' | head -n 45 |
    sed -E 's/^[0-9\/]+ ([0-9:]+)\.[0-9]+/\1/; s/[A-Za-z0-9_-]{16,}/<R>/g'
echo '--- conf (no secrets)'
grep -E '^(PEER|WG_PORT|WORKERS|VK_HASH_MODE|VK_HASHES_COUNT|VK_TOKEN_SOURCE|RT_NETWORK|TURN_SNI|RT_MASQUE)=' "$D/wdtt-plus.conf" |
    sed -E "s/^PEER=.*/PEER=<set>/"
echo '--- files'
ls "$D" | grep -E 'vk_api_calls|vk_manual|stopped'
