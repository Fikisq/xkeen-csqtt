#!/bin/sh
# Create and finish only the VK calls owned by the router WDTT Plus service.
set -eu
DIR=/opt/etc/wdtt-plus
. "$DIR/wdtt-plus.conf"
CALLS_FILE="$DIR/vk_api_calls"
case "${VK_TOKEN_SOURCE:-own}" in
    own) TOKEN_FILE="$DIR/vk_token" ;;
    csqtt) TOKEN_FILE=/opt/etc/csqtt/vk_token ;;
    *) echo "неизвестный источник VK-токена" >&2; exit 1 ;;
esac
TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null) || { echo "VK-токен не сохранён" >&2; exit 1; }
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "неверный формат VK-токена" >&2; exit 1; }

vk_request() {
    method=$1
    shift
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
        /opt/bin/curl --config - --silent --show-error --fail-with-body \
            --connect-timeout 8 --max-time 20 --request POST \
            --data-urlencode 'v=5.199' "$@" "https://api.vk.ru/method/$method"
}

finish_calls() {
    [ -f "$CALLS_FILE" ] || return 0
    failed=0
    while IFS= read -r call_id; do
        [ -n "$call_id" ] || continue
        case "$call_id" in *[!A-Za-z0-9_-]*) failed=1; continue ;; esac
        response=$(vk_request calls.forceFinish --data-urlencode "call_id=$call_id") || { failed=1; continue; }
        printf '%s' "$response" | /opt/bin/jq -e '.error == null' >/dev/null 2>&1 || failed=1
    done < "$CALLS_FILE"
    if [ "$failed" -eq 0 ]; then rm -f "$CALLS_FILE"; else return 1; fi
}

case "${1:-}" in
    stop) finish_calls ;;
    start)
        finish_calls || { echo "предыдущие звонки VK ещё не завершены" >&2; exit 1; }
        case "$WORKERS" in ''|*[!0-9]*) echo "неверное число потоков" >&2; exit 1 ;; esac
        required=$(( (WORKERS + 26) / 27 ))
        count=$(( (WORKERS + 8) / 9 + 1 ))
        [ "$count" -gt 4 ] && count=4
        [ "$required" -ge 1 ] && [ "$required" -le 4 ] || { echo "число звонков VK вне диапазона" >&2; exit 1; }
        umask 077
        : > "$CALLS_FILE"
        hashes=''
        index=0
        while [ "$index" -lt "$count" ]; do
            if ! response=$(vk_request calls.start); then
                if [ "$index" -ge "$required" ]; then
                    echo "резервный звонок VK недоступен; продолжаю с $index звонками" >&2
                    break
                fi
                finish_calls || true
                echo "VK API не создал обязательный звонок" >&2
                exit 1
            fi
            call_id=$(printf '%s' "$response" | /opt/bin/jq -r '.response.call_id // empty')
            hash=$(printf '%s' "$response" | /opt/bin/jq -r '.response.ok_join_link // .response.join_link // empty')
            hash=${hash%%\?*}
            hash=${hash%/}
            hash=${hash##*/}
            [ -n "$call_id" ] && printf '%s\n' "$call_id" >> "$CALLS_FILE"
            if [ -z "$call_id" ] || [ -z "$hash" ]; then
                code=$(printf '%s' "$response" | /opt/bin/jq -r '.error.error_code // 0' 2>/dev/null || echo 0)
                if [ "$index" -ge "$required" ] && [ -z "$call_id" ]; then
                    echo "резервный звонок VK отклонён (код $code); продолжаю с $index звонками" >&2
                    break
                fi
                finish_calls || true
                echo "VK API не вернул звонок (код $code)" >&2
                exit 1
            fi
            if [ -n "$hashes" ]; then hashes="$hashes,$hash"; else hashes="$hash"; fi
            index=$((index + 1))
            [ "$index" -lt "$count" ] && sleep 1
        done
        printf '%s\n' "$hashes"
        ;;
    *) echo "Usage: $0 start|stop" >&2; exit 2 ;;
esac
