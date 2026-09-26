#!/bin/sh
# Close an Auto VK call left by an interrupted CSQTT client before another starts.
set -eu
DIR=/opt/etc/csqtt
CALLS_FILE="$DIR/vk_js_calls"
[ -e "$CALLS_FILE" ] || exit 0
if [ ! -s "$CALLS_FILE" ]; then
    rm -f "$CALLS_FILE"
    exit 0
fi

TOKEN=$(cat "$DIR/vk_token" 2>/dev/null) || { echo 'Нет токена для закрытия звонка Auto VK' >&2; exit 1; }
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo 'Неверный формат токена Auto VK' >&2; exit 1; }

while IFS= read -r call_id; do
    [ -n "$call_id" ] || continue
    case "$call_id" in *[!A-Za-z0-9-]*) echo 'Неверный ID звонка Auto VK' >&2; exit 1 ;; esac
    closed=0
    attempt=0
    while [ "$attempt" -lt 3 ]; do
        attempt=$((attempt + 1))
        if response=$(printf 'data-urlencode = "access_token=%s"\n' "$TOKEN" |
            /opt/bin/curl --config - --silent --show-error --fail-with-body \
                --connect-timeout 8 --max-time 20 --request POST \
                --data-urlencode 'call_id='"$call_id" \
                'https://api.vk.ru/method/calls.forceFinish?v=5.285&client_id=6287487'); then
            if printf '%s' "$response" | /opt/bin/jq -e '.error == null' >/dev/null 2>&1; then
                closed=1
                break
            fi
            code=$(printf '%s' "$response" | /opt/bin/jq -r '.error.error_code // 1' 2>/dev/null || echo 1)
            case "$code" in 104|951|9000) closed=1; break ;; esac
        fi
        [ "$attempt" -lt 3 ] && sleep 1
    done
    if [ "$closed" -ne 1 ]; then
        echo 'Звонок Auto VK не закрыт; новый запуск CSQTT заблокирован' >&2
        exit 1
    fi
done < "$CALLS_FILE"
rm -f "$CALLS_FILE"
