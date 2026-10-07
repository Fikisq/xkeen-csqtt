#!/bin/sh
# Launch the APK 2.5.0 client using the isolated Bionic runtime.
# The binary remains at the existing path for PID and external API compatibility.
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
. "$DIR/csqtt.conf" || exit 1
umask 077
cd "$DIR" || exit 1

case "${VK_HASH_MODE:-auto_js}" in
    manual|auto_api|auto_js) ;;
    *) echo "неизвестный режим VK" >&2; exit 1 ;;
esac

case "$WORKERS" in
    ''|*[!0-9]*) echo "укажите число потоков от 3 до 99" >&2; exit 1 ;;
esac
[ "$WORKERS" -ge 3 ] && [ "$WORKERS" -le 99 ] || {
    echo "оригинальный клиент требует от 3 до 99 потоков в точном режиме" >&2
    exit 1
}

for required in "$DIR/csqtt-client" "$DIR/csqtt-tun-fd" \
    "$DIR/csqtt-native-events" \
    "$DIR/csqtt-dns-sync.sh" "$DIR/csqtt-flock" \
    /opt/csqtt250/linker /opt/csqtt250/lib/libc.so \
    /opt/csqtt250/lib/libdl.so /opt/csqtt250/lib/libm.so \
    /opt/csqtt250/lib/ld-android.so /opt/csqtt250/lib/libcsqtt-env.so; do
    [ -r "$required" ] || {
        echo "не найден обязательный файл среды CSQTT: $required" >&2
        exit 1
    }
done
[ -x "$DIR/csqtt-client" ] && [ -x "$DIR/csqtt-tun-fd" ] && \
    [ -x "$DIR/csqtt-native-events" ] && \
    [ -x "$DIR/csqtt-dns-sync.sh" ] && \
    [ -x "$DIR/csqtt-flock" ] && \
    [ -x /opt/csqtt250/linker ] || {
    echo "клиент, помощник TUN или загрузчик не исполняемый" >&2
    exit 1
}

# Retain a parent in both modes to own the adapter and helper lifecycle.
CHILD=''
ADAPTER=''
HELPER=''
DNS_LOOP=''
API_CALLS_ATTEMPTED=0
AUXILIARY_STARTED=0
RESOLVER_TMP=''
stop_auxiliary() {
    if [ -n "$DNS_LOOP" ] && [ -r "/proc/$DNS_LOOP/cmdline" ]; then
        case "$(tr '\000' ' ' < "/proc/$DNS_LOOP/cmdline")" in
            *"$DIR/csqtt-run-250.sh"*) kill -TERM "$DNS_LOOP" 2>/dev/null || true ;;
        esac
    fi
    [ -z "$DNS_LOOP" ] || wait "$DNS_LOOP" 2>/dev/null || true
    if [ "$AUXILIARY_STARTED" -eq 1 ]; then
        "$DIR/csqtt-dns-sync.sh" clear || {
            echo "[DNS] Не удалось очистить собственные правила DNS для CSQTT" >&2
        }
    fi
    # The TUN helper may exit after configuring the address. Avoid signalling
    # an unrelated process if its old PID has been reused during a long session.
    for auxiliary in "$ADAPTER:$DIR/csqtt-native-events" "$HELPER:$DIR/csqtt-tun-fd"; do
        auxiliary_pid=${auxiliary%%:*}
        auxiliary_path=${auxiliary#*:}
        [ -n "$auxiliary_pid" ] || continue
        if [ -r "/proc/$auxiliary_pid/cmdline" ]; then
            case "$(tr '\000' ' ' < "/proc/$auxiliary_pid/cmdline")" in
                *"$auxiliary_path"*) kill "$auxiliary_pid" 2>/dev/null || true ;;
            esac
        fi
        wait "$auxiliary_pid" 2>/dev/null || true
    done
    if [ "$AUXILIARY_STARTED" -eq 1 ]; then
        rm -f "$DIR/csqtt-native-events.pid" "$DIR/csqtt-tun-fd.pid" "$DIR/csqtt-dns-loop.pid"
    fi
}
owns_native_child() {
    [ -n "$CHILD" ] && [ -r "/proc/$CHILD/cmdline" ] || return 1
    case "$(tr '\000' ' ' < "/proc/$CHILD/cmdline")" in
        *"$DIR/csqtt-client"*) return 0 ;;
    esac
    return 1
}
stop_native_client() {
    trap '' HUP INT TERM
    if [ -n "$CHILD" ]; then
        if owns_native_child && [ "${VK_HASH_MODE:-}" = auto_js ]; then
            # APK protocol: finish native-owned calls before stopping the core.
            # The supervisor, not the native child, receives the service signal.
            (printf 'FINISH_VK_CALLS\nSTOP\n' >&3) &
            CONTROL_WRITER=$!
            w=0
            while kill -0 "$CONTROL_WRITER" 2>/dev/null && [ "$w" -lt 3 ]; do
                sleep 1; w=$((w + 1))
            done
            kill -0 "$CONTROL_WRITER" 2>/dev/null && kill "$CONTROL_WRITER" 2>/dev/null || true
            wait "$CONTROL_WRITER" 2>/dev/null || true
            n=0
            while owns_native_child && [ "$n" -lt 60 ]; do
                sleep 1; n=$((n + 1))
            done
            if owns_native_child; then
                echo '[AUTO VK] Завершение звонков не подтверждено: клиент не завершился за 60 секунд' >&2
            fi
        fi
        owns_native_child && kill -INT "$CHILD" 2>/dev/null || true
        n=0
        while owns_native_child && [ "$n" -lt 10 ]; do
            sleep 1
            n=$((n + 1))
        done
        owns_native_child && kill -KILL "$CHILD" 2>/dev/null || true
        wait "$CHILD" 2>/dev/null || true
    fi
    stop_auxiliary
    [ -z "$RESOLVER_TMP" ] || rm -f "$RESOLVER_TMP"
    if [ "$API_CALLS_ATTEMPTED" -eq 1 ] && [ ! -f "$DIR/stopped" ]; then
        "$DIR/csqtt-api-calls.sh" stop || exit 1
    fi
    exit "${1:-0}"
}
trap stop_native_client HUP INT TERM

# Always use the latest panel setting. The system resolver is only read and
# copied in system mode; all writes remain in the client-private directory.
RESOLVER_TMP=/opt/csqtt250/resolv.conf.tmp.$$
case "${BOOTSTRAP_DNS:-yandex}" in
    yandex) RESOLVER_IPS='77.88.8.8,77.88.8.1' ;;
    cloudflare) RESOLVER_IPS='1.1.1.1,1.0.0.1' ;;
    google) RESOLVER_IPS='8.8.8.8,8.8.4.4' ;;
    system) RESOLVER_IPS='' ;;
    *) RESOLVER_IPS=$BOOTSTRAP_DNS ;;
esac
if [ "${BOOTSTRAP_DNS:-yandex}" = system ]; then
    cp /etc/resolv.conf "$RESOLVER_TMP" || {
        echo "не удалось прочитать системный DNS для частного resolver CSQTT" >&2
        stop_native_client 1
    }
else
    # Accept one or two canonical IPv4 addresses. Private/loopback DNS is valid;
    # unspecified and multicast addresses cannot be DNS destinations.
    printf '%s\n' "$RESOLVER_IPS" | awk '
        {
            if (NR != 1) exit 1
            count = split($0, ips, ",")
            if (count < 1 || count > 2) exit 1
            for (i = 1; i <= count; i++) {
                sub(/^[ \t]+/, "", ips[i])
                sub(/[ \t]+$/, "", ips[i])
                if (split(ips[i], octets, /[.]/) != 4) exit 1
                for (j = 1; j <= 4; j++) {
                    if (octets[j] !~ /^[0-9]+$/ || length(octets[j]) > 3 ||
                        (length(octets[j]) > 1 && substr(octets[j], 1, 1) == "0") ||
                        octets[j] + 0 > 255) exit 1
                }
                if (ips[i] == "0.0.0.0" || (octets[1] + 0 >= 224 && octets[1] + 0 <= 239)) exit 1
                output[i] = "nameserver " ips[i]
            }
            for (i = 1; i <= count; i++) print output[i]
        }
    ' > "$RESOLVER_TMP" || {
        echo "DNS для VK: выберите провайдера или укажите один-два IPv4 через запятую" >&2
        stop_native_client 1
    }
fi
chmod 600 "$RESOLVER_TMP" && mv -f "$RESOLVER_TMP" /opt/csqtt250/resolv.conf || {
    echo "не удалось атомарно обновить частный resolver CSQTT" >&2
    stop_native_client 1
}
RESOLVER_TMP=''

SESSION_EPOCH=$(date +%s)
SESSION_SALT=$(hexdump -v -n 16 -e '1/1 "%02x"' /dev/urandom)
[ "${#SESSION_SALT}" -eq 32 ] || {
    echo "не удалось создать salt сессии" >&2
    exit 1
}

set -- "$DIR/csqtt-client" \
    --peer "$PEER" \
    --password "$PASSWORD" \
    --device-id "$DEVICE_ID" \
    --gen "$SESSION_EPOCH" \
    --salt "$SESSION_SALT" \
    -n "$WORKERS" \
    --exact-workers \
    --listen "$LISTEN" \
    --fingerprint "$FINGERPRINT" \
    --client-ids "$CLIENT_IDS" \
    --obfs "$OBFS" \
    --turn-transport "$TURN_TRANSPORT" \
    --captcha-mode "${CSQTT_CAPTCHA_MODE:-$CAPTCHA_MODE}" \
    --tun-uds csqtt_router_tun_uds

# The original APK client has no --bootstrap-dns option.
# A private resolver file is regenerated from BOOTSTRAP_DNS on every launch.
if [ -n "${CUSTOM_TURN_IPS:-}" ]; then
    set -- "$@" --custom-turn-ips "$CUSTOM_TURN_IPS"
fi

FIFO="$DIR/bootstrap.fifo"
[ -p "$FIFO" ] || mkfifo "$FIFO" || {
    echo "не удалось создать канал управления CSQTT" >&2
    exit 1
}
# Prepare all fallible local control resources before creating external calls.
exec 3<> "$FIFO"
touch "$DIR/csqtt.log" || exit 1
LOG_OFFSET=$(wc -c < "$DIR/csqtt.log")
printf '%s\n' "$LOG_OFFSET" > /opt/csqtt250/session-log-offset
# Only fresh CONFIG from this launch may drive the client-private DNS policy.
rm -f /opt/csqtt250/internet-dns.json /opt/csqtt250/captcha.json || exit 1

case "$VK_HASH_MODE" in
    auto_js)
        [ -s "$DIR/vk_token" ] || { echo 'Для Авто ВК нужен сохранённый VK-токен' >&2; exit 1; }
        BOOTSTRAP=$(/opt/bin/jq -cn --rawfile token "$DIR/vk_token" '{token:($token|rtrimstr("\n")|rtrimstr("\r"))}' | base64 | tr -d '\n')
        [ -n "$BOOTSTRAP" ] && [ "${#BOOTSTRAP}" -lt 3500 ] || { echo 'Не удалось подготовить Авто ВК' >&2; exit 1; }
        /opt/bin/vk-manual-hashes.sh release csqtt || exit 1
        set -- "$@" --vk-hash-mode auto_js --vk-auth-mode auto_js
        printf 'VK_JS_BOOTSTRAP:%s\n' "$BOOTSTRAP" >&3
        unset BOOTSTRAP
        ;;
    manual)
        [ -n "${VK_HASHES:-}" ] || {
            echo "для ручного режима укажите ссылки или хеши VK" >&2
            exit 1
        }
        /opt/bin/vk-manual-hashes.sh activate csqtt "$VK_HASHES" || exit 1
        set -- "$@" --vk "$VK_HASHES" --vk-hash-mode manual --vk-auth-mode vkcalls
        ;;
    auto_api)
        /opt/bin/vk-manual-hashes.sh release csqtt || exit 1
        API_CALLS_ATTEMPTED=1
        VK_API_HASHES=$("$DIR/csqtt-api-calls.sh" start) || {
            echo "не удалось создать звонки через VK API" >&2
            stop_native_client 1
        }
        [ -n "$VK_API_HASHES" ] || {
            echo "VK API не вернул хеши звонков" >&2
            stop_native_client 1
        }
        set -- "$@" --vk "$VK_API_HASHES" --vk-hash-mode auto_api \
            --vk-auth-mode vkcalls --allow-hash-redistribution
        ;;
esac

# Keep the control pipe open in every supported mode. The event adapter sends
# server domain updates through it; a closed stdin would stop control reading.
AUXILIARY_STARTED=1
"$DIR/csqtt-native-events" --log "$DIR/csqtt.log" --fifo "$FIFO" \
    --start-offset "$LOG_OFFSET" --dns-state /opt/csqtt250/internet-dns.json &
ADAPTER=$!
echo "$ADAPTER" > "$DIR/csqtt-native-events.pid"

"$DIR/csqtt-tun-fd" csqtt0 csqtt_router_tun_uds "$DIR/csqtt.log" &
HELPER=$!
echo "$HELPER" > "$DIR/csqtt-tun-fd.pid"

# Synchronize only the helper's owned DNS policy. Failure is logged once per
# consecutive failure period and does not stop the native tunnel.
(
    SYNC_CHILD=''
    SYNC_FAILED=0
    stop_dns_loop() {
        trap '' HUP INT TERM
        if [ -n "$SYNC_CHILD" ]; then
            if [ -r "/proc/$SYNC_CHILD/cmdline" ]; then
                case "$(tr '\000' ' ' < "/proc/$SYNC_CHILD/cmdline")" in
                    *"$DIR/csqtt-dns-sync.sh"*) kill -TERM "$SYNC_CHILD" 2>/dev/null || true ;;
                esac
            fi
            wait "$SYNC_CHILD" 2>/dev/null || true
        fi
        exit 0
    }
    trap stop_dns_loop HUP INT TERM
    while :; do
        "$DIR/csqtt-dns-sync.sh" sync &
        SYNC_CHILD=$!
        if wait "$SYNC_CHILD"; then
            SYNC_FAILED=0
        else
            if [ "$SYNC_FAILED" -eq 0 ]; then
                echo "[DNS] Не удалось синхронизировать правила DNS для CSQTT" >&2
            fi
            SYNC_FAILED=1
        fi
        SYNC_CHILD=''
        sleep 3
    done
) &
DNS_LOOP=$!
echo "$DNS_LOOP" > "$DIR/csqtt-dns-loop.pid"

# Bionic variables apply only to the client, never shell/API/curl/adapter/helper.
env LD_LIBRARY_PATH=/opt/csqtt250/lib \
    ANDROID_ROOT=/opt/csqtt250 ANDROID_DATA=/opt/csqtt250 \
    LD_PRELOAD=/opt/csqtt250/lib/libcsqtt-env.so \
    CSQTT_RESOLV_CONF=/opt/csqtt250/resolv.conf \
    RAYON_NUM_THREADS=2 CSQTT_EVENTS=1 "$@" < "$FIFO" &
CHILD=$!
wait "$CHILD"
RESULT=$?
CHILD=''
stop_auxiliary
if [ "$VK_HASH_MODE" = auto_api ]; then
    "$DIR/csqtt-api-calls.sh" stop || RESULT=1
fi
exit "$RESULT"
