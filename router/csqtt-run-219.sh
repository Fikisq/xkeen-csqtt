#!/bin/sh
# Launcher for amurcanov CSQTT v2.1.9 with the router call-closure patch.
DIR=$(dirname "$0")
. "$DIR/csqtt.conf"
umask 077

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
    --tun-uds csqtt_router_tun_uds

case "${VK_HASH_MODE:-auto_js}" in
    manual)
        [ -n "${VK_HASHES:-}" ] || { echo "для ручного режима укажите ссылки или хеши VK"; exit 1; }
        /opt/bin/vk-manual-hashes.sh activate csqtt "$VK_HASHES" || exit 1
        set -- "$@" --vk "$VK_HASHES" --vk-hash-mode manual --vk-auth-mode vkcalls
        ;;
    auto_api)
        /opt/bin/vk-manual-hashes.sh release csqtt || exit 1
        VK_API_HASHES=$("$DIR/csqtt-api-calls.sh" start) || { echo "не удалось создать звонки через VK API"; exit 1; }
        [ -n "$VK_API_HASHES" ] || { echo "VK API не вернул хеши звонков"; exit 1; }
        set -- "$@" --vk "$VK_API_HASHES" --vk-hash-mode auto_api --vk-auth-mode vkcalls --allow-hash-redistribution
        ;;
    auto_js)
        /opt/bin/vk-manual-hashes.sh release csqtt || exit 1
        export CSQTT_VK_CALLS_FILE="$DIR/vk_js_calls"
        set -- "$@" --vk-hash-mode auto_js --vk-auth-mode auto_js
        TOKEN=$(cat "$DIR/vk_token" 2>/dev/null) || { echo "нет vk_token"; exit 1; }
        BOOTSTRAP=$(printf '{"token":"%s"}' "$TOKEN" | base64 | tr -d '\n')
        FIFO="$DIR/bootstrap.fifo"
        [ -p "$FIFO" ] || mkfifo "$FIFO" || { echo "не удалось создать fifo"; exit 1; }
        # Keep a writer open after exec so the client's control reader does not
        # see EOF before the service can send FINISH_VK_CALLS and STOP.
        exec 3<> "$FIFO"
        printf 'VK_JS_BOOTSTRAP:%s\n' "$BOOTSTRAP" >&3
        ;;
    *) echo "неизвестный режим VK"; exit 1 ;;
esac

"$DIR/csqtt-tun-fd" csqtt0 csqtt_router_tun_uds "$DIR/csqtt.log" &
echo $! > "$DIR/csqtt-tun-fd.pid"
if [ "${VK_HASH_MODE:-auto_js}" = auto_js ]; then
    exec "$@" < "$FIFO"
fi
exec "$@"
