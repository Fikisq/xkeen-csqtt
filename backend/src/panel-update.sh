#!/bin/sh
PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
work=$1
job=$2
version=$3
expected=$4
port=$5
status=/var/run/xkeen-ui-update.json
lock=/var/run/xkeen-ui-update.lock
target=/opt/sbin/xkeen-ui
init=/opt/etc/init.d/S99xkeen-ui
case "$work" in /opt/sbin/.xkeen-ui-update-*) ;; *) exit 1;; esac
[ "$(readlink -f "$work")" = "$work" ] || exit 1
[ -f "$work/previous" ] && [ -f "$work/candidate" ] || exit 1
write_status() {
    printf '{"id":"%s","targetVersion":"%s","phase":"%s","message":"%s"}\n' "$job" "$version" "$1" "$2" > "$status.$job.tmp" &&
    chmod 600 "$status.$job.tmp" && mv -f "$status.$job.tmp" "$status"
}
cleanup() {
    rmdir "$lock" 2>/dev/null || true
    [ "$(readlink -f "$work")" = "$work" ] && rm -rf -- "$work"
}
trap cleanup EXIT
# Let the HTTP response leave the old panel before its process is stopped.
sleep 3
if ! "$init" stop >/dev/null 2>&1; then
    write_status error 'Не удалось остановить прежнюю панель; файл не заменён'
    "$init" start >/dev/null 2>&1
    exit 1
fi
if mv -f "$work/candidate" "$target"; then
    chmod 711 "$target"
    sync
    "$init" start >/dev/null 2>&1
    count=0
    while [ "$count" -lt 45 ]; do
        current=no
        for pid in $(pidof xkeen-ui 2>/dev/null); do
            # Require the running executable, not just a matching version from
            # an old process that might still be answering on the HTTP port.
            running_hash=$(sha256sum "/proc/$pid/exe" 2>/dev/null | cut -d ' ' -f 1)
            [ "$running_hash" = "$expected" ] && current=yes
        done
        if [ "$current" = yes ] && /opt/bin/curl -fsS --max-time 2 --noproxy '*' --proxy '' "http://127.0.0.1:$port/api/auth/login" >/dev/null 2>&1; then
            # Retain exactly one binary backup, without any user secrets.
            mv -f "$work/previous" /opt/sbin/xkeen-ui.previous
            chmod 711 /opt/sbin/xkeen-ui.previous
            write_status installed 'Панель установлена'
            exit 0
        fi
        sleep 1
        count=$((count + 1))
    done
fi
"$init" stop >/dev/null 2>&1 || true
if mv -f "$work/previous" "$target"; then
    chmod 711 "$target"
    sync
    "$init" start >/dev/null 2>&1
    write_status rolled_back 'Новая панель не запустилась; восстановлена предыдущая версия'
else
    write_status error 'Не удалось восстановить панель; используйте резервную копию'
fi
