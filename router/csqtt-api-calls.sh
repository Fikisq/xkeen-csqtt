#!/bin/sh
# Router-side equivalent of the original Android calls.start / calls.forceFinish flow.
set -eu
DIR=$(dirname "$0")
CALLS_FILE="$DIR/vk_api_calls"
TOKEN=''
umask 077
# Serialize all creation/cleanup, including cleanup by the launcher and init.
LOCK="$DIR/vk_api_calls.lock"
mkdir "$LOCK" 2>/dev/null || { echo "Операция VK API уже выполняется; повторите остановку позже" >&2; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
UNCERTAIN="$DIR/vk_api_calls.uncertain"
load_token() {
    TOKEN=$(cat "$DIR/vk_token" 2>/dev/null) || { echo "VK token не найден" >&2; return 1; }
    printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "Неверный формат VK token" >&2; return 1; }
}

vk_request() {
    method=$1
    shift
    [ -n "$TOKEN" ] || load_token || return 1
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
        /opt/bin/curl --config - --silent --show-error --fail-with-body \
            --connect-timeout 8 --max-time 20 --request POST \
            --data-urlencode 'v=5.199' "$@" "https://api.vk.ru/method/$method"
}

# Only an explicit success confirms closure. Preserve every other result.
finish_file() {
    file=$1
    [ -f "$file" ] || return 0
    remaining=''
    while IFS= read -r call_id; do
        [ -n "$call_id" ] || continue
        case "$call_id" in *[!A-Za-z0-9_-]*) echo "Неверный ID звонка; файл сохранён" >&2; return 1 ;; esac
        attempt=0
        closed=0
        while [ "$attempt" -lt 3 ]; do
            attempt=$((attempt + 1))
            if response=$(vk_request calls.forceFinish --data-urlencode "call_id=$call_id"); then
                if printf '%s' "$response" | /opt/bin/jq -e '.error == null and .response == 1' >/dev/null 2>&1; then
                    closed=1
                    break
                fi
            fi
            [ "$attempt" -lt 3 ] && sleep 1
        done
        [ "$closed" -eq 1 ] || remaining="$remaining$call_id
"
    done < "$file"
    if [ -n "$remaining" ]; then
        printf '%s' "$remaining" > "$file.tmp"
        mv "$file.tmp" "$file"
        return 1
    fi
    rm -f "$file"
    return 0
}

# Retain failed IDs, but never create another call while any remain open.
finish_calls() {
    failed=0
    finish_file "$CALLS_FILE" || failed=1
    finish_file "$CALLS_FILE.stale" || failed=1
    if [ "$failed" -ne 0 ]; then
        echo "Звонки VK не закрыты; новые звонки CSQTT создавать нельзя" >&2
        return 1
    fi
    if [ -f "$UNCERTAIN" ]; then
        echo "Результат создания звонка VK неизвестен. Auto API заблокирован до проверки незавершённых звонков" >&2
        return 1
    fi
}

case "${1:-}" in
    stop) finish_calls ;;
    start)
        finish_calls || exit 1
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
            call_id=''
            hash=''
            # Write before sending: a timeout or killed process must never cause
            # an automatic duplicate calls.start on the next service start.
            date +%s > "$UNCERTAIN"
            if response=$(vk_request calls.start); then
                call_id=$(printf '%s' "$response" | /opt/bin/jq -r '.response.call_id // empty' 2>/dev/null) || call_id=''
                case "$call_id" in *[!A-Za-z0-9_-]*) call_id='' ;; esac
                if [ -n "$call_id" ]; then
                    printf '%s\n' "$call_id" >> "$CALLS_FILE"
                    rm -f "$UNCERTAIN"
                    hash=$(printf '%s' "$response" | /opt/bin/jq -r '.response.ok_join_link | select(type == "string" and length > 0)' 2>/dev/null) || hash=''
                    [ -n "$hash" ] || hash=$(printf '%s' "$response" | /opt/bin/jq -r '.response.join_link // empty' 2>/dev/null) || hash=''
                elif printf '%s' "$response" | /opt/bin/jq -e '.error.error_code | numbers | select(. > 0)' >/dev/null 2>&1; then
                    # Explicit rejection, unlike a lost response, created no known call.
                    rm -f "$UNCERTAIN"
                fi
            fi
            hash=${hash%%\?*}
            hash=${hash%/}
            hash=${hash##*/}
            index=$((index + 1))
            if [ -z "$call_id" ] || [ -z "$hash" ]; then
                finish_calls || true
                echo "VK API не подтвердил создание звонка; автоматический повтор отменён" >&2
                exit 1
            else
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
