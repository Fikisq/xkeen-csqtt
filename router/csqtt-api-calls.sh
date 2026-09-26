#!/bin/sh
# Router-side equivalent of the original Android calls.start / calls.forceFinish flow.
set -eu
DIR=$(dirname "$0")
CALLS_FILE="$DIR/vk_api_calls"
TOKEN=$(cat "$DIR/vk_token" 2>/dev/null) || { echo "VK token не найден" >&2; exit 1; }
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "Неверный формат VK token" >&2; exit 1; }

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
        finish_calls || { echo "Предыдущие звонки VK ещё не завершены" >&2; exit 1; }
        . "$DIR/csqtt.conf"
        case "$WORKERS" in ''|*[!0-9]*) echo "Неверное число потоков" >&2; exit 1 ;; esac
        count=$(( (WORKERS + 26) / 27 ))
        [ "$count" -ge 1 ] && [ "$count" -le 6 ] || { echo "Число звонков VK вне диапазона" >&2; exit 1; }
        umask 077
        : > "$CALLS_FILE"
        hashes=''
        index=0
        created=0
        while [ "$index" -lt "$count" ]; do
            attempt=0
            call_id=''
            hash=''
            code=0
            while [ "$attempt" -lt 3 ]; do
                attempt=$((attempt + 1))
                if response=$(vk_request calls.start); then
                    call_id=$(printf '%s' "$response" | /opt/bin/jq -r '.response.call_id // empty')
                    hash=$(printf '%s' "$response" | /opt/bin/jq -r '.response.ok_join_link // .response.join_link // empty')
                    code=$(printf '%s' "$response" | /opt/bin/jq -r '.error.error_code // 0' 2>/dev/null || echo 0)
                    [ -n "$call_id" ] && [ -n "$hash" ] && break
                    case "$code" in 4|5|18|27|28) break ;; esac
                fi
                [ "$attempt" -lt 3 ] && sleep 1
            done
            hash=${hash%%\?*}
            hash=${hash%/}
            hash=${hash##*/}
            index=$((index + 1))
            if [ -z "$call_id" ] || [ -z "$hash" ]; then
                if [ -n "$call_id" ]; then printf '%s\n' "$call_id" >> "$CALLS_FILE"; fi
                case "$code" in
                    4|5|18|27|28)
                        finish_calls || true
                        echo "VK отклонил токен или аккаунт (код $code)" >&2
                        exit 1
                        ;;
                esac
                echo "VK API не вернул звонок $index из $count после $attempt попыток (код $code)" >&2
            else
                printf '%s\n' "$call_id" >> "$CALLS_FILE"
                created=$((created + 1))
                if [ -n "$hashes" ]; then hashes="$hashes,$hash"; else hashes="$hash"; fi
            fi
            [ "$index" -lt "$count" ] && sleep 1
        done
        if [ -z "$hashes" ]; then
            finish_calls || true
            echo "VK API не создал ни одного звонка" >&2
            exit 1
        fi
        [ "$created" -lt "$count" ] && echo "VK создал $created из $count звонков; потоки распределены по доступным" >&2
        printf '%s\n' "$hashes"
        ;;
    *) echo "Usage: $0 start|stop" >&2; exit 2 ;;
esac
