#!/bin/sh
# Offline check of wdtt-plus-calls.sh against a fake VK API. $1 = script to test.
set -u
R=/tmp/xk-calls; rm -rf $R; mkdir -p $R/wdtt-plus; chmod 700 $R
printf "PEER='1.2.3.4:56000'\nWORKERS='36'\nVK_TOKEN_SOURCE='own'\n" > $R/wdtt-plus/wdtt-plus.conf
echo faketoken123 > $R/wdtt-plus/vk_token
cat > $R/curl <<'EOF'
#!/bin/sh
R=/tmp/xk-calls
cat >/dev/null
url=; id=
for a in "$@"; do case "$a" in https://*) url=$a ;; call_id=*) id=${a#call_id=} ;; esac; done
case "$url" in
  *calls.start)
    n=$(( $(cat $R/n 2>/dev/null || echo 0) + 1 )); echo $n > $R/n
    printf '{"response":{"call_id":"new%s","join_link":"https://vk.com/call/join/h%s"}}' $n $n ;;
  *calls.forceFinish)
    echo "$id" >> $R/tried
    printf '%s' "$(cat $R/finish_mode)" | grep -q ok && { printf '{"response":1}'; exit 0; }
    printf '%s' "$(cat $R/finish_mode)" | grep -q gone && { printf '{"error":{"error_code":9000,"error_msg":"Call not found"}}'; exit 0; }
    printf '{"error":{"error_code":10,"error_msg":"Internal server error"}}' ;;
esac
EOF
chmod +x $R/curl
sed -e "s#^DIR=/opt/etc/wdtt-plus#DIR=$R/wdtt-plus#; s#/opt/bin/curl#$R/curl#g; s#/opt/bin/jq#/opt/bin/jq#g; s#sleep 1#sleep 0#g" "$1" > $R/calls.sh
chmod +x $R/calls.sh
C=$R/wdtt-plus/vk_api_calls

run() {
    mode=$1; shift
    echo "$mode" > $R/finish_mode
    rm -f $R/tried
    printf 'old1\nold2\n' > $C
    out=$("$R/calls.sh" start 2>$R/err); rc=$?
    printf '%-6s rc=%s hashes=[%s]\n' "$mode" "$rc" "$out"
    printf '       stderr: %s\n' "$(tr '\n' ';' < $R/err)"
    printf '       active=[%s] stale=[%s]\n' \
        "$(cat $C 2>/dev/null | tr '\n' ,)" "$(cat $C.stale 2>/dev/null | tr '\n' ,)"
    rm -f $C $C.stale
}

echo '1. VK refuses forever (code 10) - start must still succeed and park the old ids'
run fail
echo '2. VK says the call is gone (9000) - old ids must just disappear'
run gone
echo '3. VK finishes normally'
run ok
rm -rf $R
