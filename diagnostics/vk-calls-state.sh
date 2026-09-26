#!/bin/sh
# Why does wdtt-plus-calls.sh refuse to start? No secrets are printed.
D=/opt/etc/wdtt-plus
. "$D/wdtt-plus.conf"
case "${VK_TOKEN_SOURCE:-own}" in
    own) TOKEN_FILE=$D/vk_token ;;
    csqtt) TOKEN_FILE=/opt/etc/csqtt/vk_token ;;
esac
printf 'token source=%s file=%s present=%s size_ok=%s\n' \
    "${VK_TOKEN_SOURCE:-own}" "$TOKEN_FILE" \
    "$([ -f "$TOKEN_FILE" ] && echo yes || echo no)" \
    "$([ -s "$TOKEN_FILE" ] && echo yes || echo no)"
if [ -f "$D/vk_api_calls" ]; then
    printf 'vk_api_calls: %s ids, mtime %s\n' \
        "$(grep -c . "$D/vk_api_calls")" "$(date -r "$D/vk_api_calls" '+%F %T')"
else
    printf 'vk_api_calls: absent\n'
fi
[ -s "$TOKEN_FILE" ] || exit 0
TOKEN=$(cat "$TOKEN_FILE")
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._-]+$' && echo 'token format: ok' || echo 'token format: BAD'
resp=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    /opt/bin/curl --config - --silent --show-error --fail-with-body \
        --connect-timeout 8 --max-time 20 --request POST \
        --data-urlencode 'v=5.199' https://api.vk.ru/method/users.get)
printf 'users.get: %s\n' "$(printf '%s' "$resp" | /opt/bin/jq -c 'if .error then {code:.error.error_code,msg:.error.error_msg} else {ok:true} end')"
[ -f "$D/vk_api_calls" ] || exit 0
echo '--- forceFinish per stored id (ids not printed)'
i=0
while IFS= read -r id; do
    [ -n "$id" ] || continue
    i=$((i + 1))
    r=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
        /opt/bin/curl --config - --silent --show-error --fail-with-body \
            --connect-timeout 8 --max-time 20 --request POST \
            --data-urlencode 'v=5.199' --data-urlencode "call_id=$id" \
            https://api.vk.ru/method/calls.forceFinish)
    rc=$?
    printf '  id#%s curl_rc=%s -> %s\n' "$i" "$rc" \
        "$(printf '%s' "$r" | /opt/bin/jq -c 'if .error then {code:.error.error_code,msg:.error.error_msg} else {response:.response} end' 2>/dev/null || echo 'unparsable')"
done < "$D/vk_api_calls"
