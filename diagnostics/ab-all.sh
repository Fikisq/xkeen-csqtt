#!/bin/sh
# A/B: stock WDTT Plus v18 vs the chunk64 build currently installed.
exec > /tmp/xk-ab-result.txt 2>&1
set -u
D=/opt/etc/wdtt-plus
swap() {
    from=$1; to=$2
    mv "$D/wdtt-plus-client" "$D/wdtt-plus-client.$from"
    mv "$D/wdtt-plus-client.$to" "$D/wdtt-plus-client"
    chmod 700 "$D/wdtt-plus-client"
    printf 'installed %s (%s)\n' "$to" "$(sha256sum "$D/wdtt-plus-client" | cut -c1-16)"
}
printf 'start %s\n' "$(date -u '+%F %T UTC')"
printf 'installed chunk64 (%s)\n' "$(sha256sum "$D/wdtt-plus-client" | cut -c1-16)"
sh /tmp/xk-ab/ab-run.sh chunk64
swap chunk64 stock
sh /tmp/xk-ab/ab-run.sh stock
swap stock chunk64
sh /tmp/xk-ab/ab-run.sh chunk64-2
swap chunk64 stock
sh /tmp/xk-ab/ab-run.sh stock-2
swap stock chunk64
rm -f "$D/wdtt-plus-client.stock"
printf 'restored %s, service stopped\n' "$(sha256sum "$D/wdtt-plus-client" | cut -c1-16)"
/opt/etc/init.d/S99wdtt-plus status
printf 'DONE %s\n' "$(date -u '+%F %T UTC')"
