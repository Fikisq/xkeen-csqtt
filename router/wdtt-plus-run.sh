#!/bin/sh
# WDTT Plus v18 native Go client in local SOCKS5+UDP mode.
set -eu
DIR=/opt/etc/wdtt-plus
. "$DIR/wdtt-plus.conf"
umask 077
PASSWORD_FILE="$DIR/password"
[ -s "$PASSWORD_FILE" ] || { echo "пароль WDTT Plus не сохранён" >&2; exit 1; }
[ -s "$DIR/device_id" ] || { echo "device_id WDTT Plus не создан" >&2; exit 1; }
DEVICE_ID=$(cat "$DIR/device_id")
case "${VK_HASH_MODE:-auto}" in
    auto)
        /opt/bin/vk-manual-hashes.sh release wdtt-plus || exit 1
        HASHES=$("$DIR/wdtt-plus-calls.sh" start)
        ;;
    manual)
        HASHES=${VK_HASHES:-}
        [ -n "$HASHES" ] || { echo "Для ручного режима укажите хеши VK" >&2; exit 1; }
        /opt/bin/vk-manual-hashes.sh activate wdtt-plus "$HASHES" || exit 1
        ;;
    *) echo "Неизвестный режим хешей WDTT Plus" >&2; exit 1 ;;
esac
PAYLOAD=$(/opt/bin/jq -Rs --arg vk_hashes "$HASHES" \
    '{vk_hashes:$vk_hashes,connection_password:.}' < "$PASSWORD_FILE" |
    base64 | tr -d '\n=' | tr '+/' '-_')
FIFO="$DIR/startup.fifo"
[ -p "$FIFO" ] || mkfifo "$FIFO"
printf 'START_CONFIG|%s\n' "$PAYLOAD" > "$FIFO" &
set -- --peer "$PEER" --device-id "$DEVICE_ID" --n "$WORKERS" \
    --listen 127.0.0.1:9089 --mode socks5 \
    --socks-listen 127.0.0.1:1088 --socks-udp=true \
    --config-first-start=true --startup-config-stdin=true
# Every group keeps its own hash as primary; the others stay eligible reserves.
# Without this a group whose hash returns ANON_BLOCKED dies for the whole run.
if [ "$(printf '%s' "$HASHES" | tr ',' '\n' | grep -c .)" -gt 1 ]; then
    set -- "$@" --hash-fallback=true
fi
if [ "${RT_NETWORK:-0}" = 1 ]; then
    set -- "$@" --turn-stream-first=true
    if [ -n "${TURN_SNI:-}" ]; then
        set -- "$@" --turn-sni "$TURN_SNI"
    fi
    if [ "${RT_MASQUE:-0}" = 1 ] && [ "${RT_MASQUE_ACCEPT_TOS:-0}" = 1 ]; then
        set -- "$@" --rt-masque=true \
            --rt-masque-config "$DIR/rt-masque-v1.json" \
            --rt-masque-accept-tos=true
    fi
fi
exec "$DIR/wdtt-plus-client" "$@" < "$FIFO"
