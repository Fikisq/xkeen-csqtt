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
HELPER=$!
echo "$HELPER" > "$DIR/csqtt-tun-fd.pid"
if [ "${VK_HASH_MODE:-auto_js}" = auto_js ]; then
    exec "$@" < "$FIFO"
fi
if [ "${VK_HASH_MODE:-auto_js}" = auto_api ]; then
    # Retain a parent so an unexpected client exit also triggers API cleanup.
    # Explicit service stop delegates cleanup to S99csqtt after child shutdown.
    CHILD=''
    stop_api_client() {
        trap '' HUP INT TERM
        if [ -n "$CHILD" ]; then
            kill -INT "$CHILD" 2>/dev/null || true
            n=0
            while kill -0 "$CHILD" 2>/dev/null && [ "$n" -lt 10 ]; do
                sleep 1; n=$((n+1))
            done
            kill -KILL "$CHILD" 2>/dev/null || true
            wait "$CHILD" 2>/dev/null || true
        fi
        kill "$HELPER" 2>/dev/null || true
        wait "$HELPER" 2>/dev/null || true
        if [ ! -f "$DIR/stopped" ]; then
            "$DIR/csqtt-api-calls.sh" stop || exit 1
        fi
        exit 0
    }
    trap stop_api_client HUP INT TERM
    "$@" &
    CHILD=$!
    wait "$CHILD"
    RESULT=$?
    CHILD=''
    kill "$HELPER" 2>/dev/null || true
    wait "$HELPER" 2>/dev/null || true
    "$DIR/csqtt-api-calls.sh" stop || RESULT=1
    exit "$RESULT"
fi
exec "$@"
