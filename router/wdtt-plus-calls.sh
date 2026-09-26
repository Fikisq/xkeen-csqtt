#!/bin/sh
# Finish only legacy VK calls previously created by the router WDTT Plus service.
set -eu
[ "${1:-}" != start ] || { echo "Автоматическое создание звонков WDTT Plus отключено" >&2; exit 1; }
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

# A call that VK no longer knows about cannot be finished; that is success.
call_gone() {
    case "$1" in 104|951|9000) return 0 ;; esac
    return 1
}

# Finishes every call listed in $1. Identifiers that fail for another reason stay
# in the file and the function returns 1, but the caller must not treat that as
# fatal: a call VK refuses to finish would otherwise block every later start.
finish_file() {
    file=$1
    [ -f "$file" ] || return 0
    remaining=''
    while IFS= read -r call_id; do
        [ -n "$call_id" ] || continue
        case "$call_id" in *[!A-Za-z0-9_-]*) continue ;; esac
        attempt=0
        closed=0
        while [ "$attempt" -lt 3 ]; do
            attempt=$((attempt + 1))
            if response=$(vk_request calls.forceFinish --data-urlencode "call_id=$call_id"); then
                if printf '%s' "$response" | /opt/bin/jq -e '.error == null' >/dev/null 2>&1; then
                    closed=1
                    break
                fi
                code=$(printf '%s' "$response" | /opt/bin/jq -r '.error.error_code // 1' 2>/dev/null || echo 1)
                if call_gone "$code"; then closed=1; break; fi
            fi
            [ "$attempt" -lt 3 ] && sleep 1
        done
        [ "$closed" -eq 1 ] || remaining="$remaining$call_id
"
    done < "$file"
    if [ -n "$remaining" ]; then
        printf '%s' "$remaining" > "$file"
        return 1
    fi
    rm -f "$file"
    return 0
}

# Never let an unfinishable call block the service: park it and retry later.
release_calls() {
    if ! finish_file "$CALLS_FILE"; then
        cat "$CALLS_FILE" >> "$CALLS_FILE.stale"
        rm -f "$CALLS_FILE"
        echo "часть прежних звонков VK не закрылась; отложены в vk_api_calls.stale" >&2
    fi
    finish_file "$CALLS_FILE.stale" || true
}

case "${1:-}" in
    stop) release_calls ;;
    *) echo "Usage: $0 stop" >&2; exit 2 ;;
esac
