#!/bin/sh
DIR=$(dirname "$0")
. "$DIR/csqtt.conf"
umask 077

# A fresh epoch makes the server discard relay sessions from previous starts.
SESSION_EPOCH=$(date +%s)
SESSION_SALT=$(hexdump -v -n 16 -e '1/1 "%02x"' /dev/urandom)
[ "${#SESSION_SALT}" -eq 32 ] || { echo "не удалось создать salt сессии"; exit 1; }

set -- "$DIR/csqtt-client" \
    --peer "$PEER" \
    --password "$PASSWORD" \
    --device-id "$DEVICE_ID" \
    --gen "$SESSION_EPOCH" \
    --salt "$SESSION_SALT" \
    -n "$WORKERS" \
    --listen "$LISTEN" \
    --fingerprint "$FINGERPRINT" \
    --client-ids "$CLIENT_IDS" \
    --obfs "$OBFS" \
    --turn-transport "$TURN_TRANSPORT" \
    --captcha-mode "$CAPTCHA_MODE" \
    --vk-pool "$DIR/vk_pool" \
    --vk-calls "$HASHES"

if [ -n "${TUN_IFACE:-}" ]; then
    set -- "$@" --tun "$TUN_IFACE" --tun-mtu "$TUN_MTU"
fi

case "${VK_HASH_MODE:-auto_js}" in
    manual)
        [ -n "${VK_HASHES:-}" ] || { echo "для ручного режима укажите ссылки или хеши VK"; exit 1; }
        set -- "$@" --vk "$VK_HASHES" --vk-hash-mode manual --vk-auth-mode vkcalls
        exec "$@"
        ;;
    auto_api)
        VK_API_HASHES=$("$DIR/csqtt-api-calls.sh" start) || { echo "не удалось создать звонки через VK API"; exit 1; }
        [ -n "$VK_API_HASHES" ] || { echo "VK API не вернул хеши звонков"; exit 1; }
        set -- "$@" --vk "$VK_API_HASHES" --vk-hash-mode auto_api --vk-auth-mode vkcalls --allow-hash-redistribution
        exec "$@"
        ;;
    auto_js)
        set -- "$@" --vk-hash-mode auto_js --vk-auth-mode auto_js
        TOKEN=$(cat "$DIR/vk_token" 2>/dev/null) || { echo "нет vk_token"; exit 1; }
        BOOTSTRAP=$(printf '{"token":"%s"}' "$TOKEN" | base64 | tr -d '\n')
        FIFO="$DIR/bootstrap.fifo"
        [ -p "$FIFO" ] || mkfifo "$FIFO" || { echo "не удалось создать fifo"; exit 1; }
        printf 'VK_JS_BOOTSTRAP:%s\n' "$BOOTSTRAP" > "$FIFO" &
        exec "$@" < "$FIFO"
        ;;
    *) echo "неизвестный режим VK"; exit 1 ;;
esac
