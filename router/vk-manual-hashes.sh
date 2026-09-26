#!/bin/sh
# Managed VK calls for the manual-hash fields of CSQTT and WDTT Plus.
set -eu
service=${2:-}
case "$service" in csqtt|wdtt-plus) ;; *) exit 2 ;; esac
dir="/opt/etc/$service"
stage="$dir/vk_manual_stage"
active="$dir/vk_manual_active"
stale="$dir/vk_manual_stale"
umask 077

token_path() {
    if [ "$service" = csqtt ]; then
        echo /opt/etc/csqtt/vk_token
    else
        . "$dir/wdtt-plus.conf"
        case "${VK_TOKEN_SOURCE:-own}" in
            own) echo /opt/etc/wdtt-plus/vk_token ;;
            csqtt) echo /opt/etc/csqtt/vk_token ;;
            *) return 1 ;;
        esac
    fi
}

vk_request() {
    method=$1
    shift
    token=$(cat "$token_file")
    printf '%s' "$token" | grep -Eq '^[A-Za-z0-9._-]+$' || return 1
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
        /opt/bin/curl --config - --silent --show-error --fail-with-body \
            --connect-timeout 8 --max-time 20 --request POST \
            --data-urlencode 'v=5.199' "$@" "https://api.vk.ru/method/$method"
}

# A call that VK no longer knows about cannot be finished; that is success.
call_gone() {
    case "$1" in 104|951|9000) return 0 ;; esac
    return 1
}

finish_file() {
    prefix=$1
    [ -f "$prefix.ids" ] || return 0
    token_file="$prefix.token"
    [ -s "$token_file" ] || return 1
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
    done < "$prefix.ids"
    if [ -n "$remaining" ]; then
        printf '%s' "$remaining" > "$prefix.ids"
        return 1
    fi
    rm -f "$prefix.ids" "$prefix.token" "$prefix.hashes" "$prefix.time"
}

# Calls VK refuses to finish are set aside so they never block a later change.
park() {
    prefix=$1
    [ -f "$prefix.ids" ] || return 0
    cat "$prefix.ids" >> "$stale.ids"
    [ -s "$stale.token" ] || cp "$prefix.token" "$stale.token" 2>/dev/null || true
    rm -f "$prefix.ids" "$prefix.token" "$prefix.hashes" "$prefix.time"
    echo 'часть звонков VK не закрылась; отложены до следующей попытки' >&2
}

expire_stage() {
    [ -f "$stage.time" ] || return 0
    created=$(cat "$stage.time")
    case "$created" in ''|*[!0-9]*) created=0 ;; esac
    [ "$(( $(date +%s) - created ))" -ge 600 ] || return 0
    finish_file "$stage"
}

case "${1:-}" in
    generate)
        [ "$service" = csqtt ] || { echo 'Создание звонков WDTT Plus отключено' >&2; exit 1; }
        count=${3:-}
        case "$count" in ''|*[!0-9]*) exit 2 ;; esac
        [ "$count" -ge 1 ] && [ "$count" -le 6 ] || exit 2
        [ "$service" = csqtt ] || [ "$count" -le 4 ] || exit 2
        finish_file "$stage" || park "$stage"
        finish_file "$stale" || true
        source=$(token_path) && [ -s "$source" ] || { echo 'VK-токен не сохранён' >&2; exit 1; }
        cp "$source" "$stage.token"
        chmod 600 "$stage.token"
        : > "$stage.ids"
        date +%s > "$stage.time"
        (sleep 600; "$0" expire "$service" >/dev/null 2>&1) </dev/null >/dev/null 2>&1 &
        trap 'finish_file "$stage" >/dev/null 2>&1 || true' HUP INT TERM
        token_file="$stage.token"
        hashes=''
        index=0
        while [ "$index" -lt "$count" ]; do
            response=$(vk_request calls.start) || { finish_file "$stage" || true; echo 'VK API не создал звонок' >&2; exit 1; }
            call_id=$(printf '%s' "$response" | /opt/bin/jq -r '.response.call_id // empty')
            hash=$(printf '%s' "$response" | /opt/bin/jq -r '.response.ok_join_link // .response.join_link // empty')
            hash=${hash%%\?*}
            hash=${hash%/}
            hash=${hash##*/}
            if [ -z "$call_id" ] || [ -z "$hash" ]; then
                [ -z "$call_id" ] || printf '%s\n' "$call_id" >> "$stage.ids"
                finish_file "$stage" || true
                echo 'VK API не вернул действующий хеш звонка' >&2
                exit 1
            fi
            printf '%s\n' "$call_id" >> "$stage.ids"
            if [ -n "$hashes" ]; then hashes="$hashes,$hash"; else hashes="$hash"; fi
            index=$((index + 1))
            [ "$index" -ge "$count" ] || sleep 1
        done
        printf '%s\n' "$hashes" > "$stage.hashes"
        trap - HUP INT TERM
        printf '%s\n' "$hashes"
        ;;
    activate)
        expected=${3:-}
        expire_stage || true
        if [ ! -f "$stage.hashes" ] || [ "$(cat "$stage.hashes")" != "$expected" ]; then
            if [ -f "$active.hashes" ] && [ "$(cat "$active.hashes")" != "$expected" ]; then
                finish_file "$active"
            fi
            exit 0
        fi
        finish_file "$active" || park "$active"
        mv "$stage.ids" "$active.ids"
        mv "$stage.token" "$active.token"
        mv "$stage.hashes" "$active.hashes"
        rm -f "$stage.time"
        ;;
    stop)
        if [ "${KEEP_MANUAL_STAGE:-0}" != 1 ]; then
            finish_file "$stage" || park "$stage"
        else
            expire_stage || park "$stage"
        fi
        finish_file "$stale" || true
        ;;
    release)
        finish_file "$active" || park "$active"
        finish_file "$stage" || park "$stage"
        finish_file "$stale" || true
        ;;
    expire) expire_stage || true ;;
    *) exit 2 ;;
esac
