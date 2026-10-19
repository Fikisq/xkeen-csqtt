#!/bin/sh
# Isolated diagnostic NFQUEUE. Only sockets explicitly marked 833 can enter it.
set -eu
set -f

ROOT=/opt/etc/xkeen/nfqws2-stage
ENGINE="$ROOT/engine"
PROBE="$ROOT/probe"
PID="$ROOT/probe.pid"
IPT=/opt/sbin/iptables
WAN=${NFQWS_WAN:-$(ip -4 route show default | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')}
MARK=833
QUEUE=331
COMMENT=xkeen_nfqws2_probe
RESULTS="$ROOT/probe-results-$$"

rule() {
    "$IPT" -t mangle "$1" OUTPUT -o "$WAN" -m mark --mark "$MARK/0xffffffff" \
        -p "$2" --dport "${3:-443}" -m comment --comment "$COMMENT" \
        -j NFQUEUE --queue-num "$QUEUE" --queue-bypass
}

cleanup() {
    for protocol in tcp udp; do
        for port in 80 443; do
            while rule -C "$protocol" "$port" >/dev/null 2>&1; do rule -D "$protocol" "$port"; done
        done
    done
    if [ -f "$PID" ]; then
        pid=$(cat "$PID")
        [ -r "/proc/$pid/exe" ] && [ "$(readlink "/proc/$pid/exe")" = "$ENGINE" ] && kill "$pid" || true
        rm -f "$PID"
    fi
    rm -rf "$RESULTS"
}

probe_sites() {
    protocol=$1
    probe_timeout=$2
    mkdir -m 700 -p "$RESULTS"
    index=0
    sites=${NFQWS_TEST_SITES:-'https://www.youtube.com/generate_204 https://discord.com/'}
    for site in $sites; do
        case "$site" in https://*) ;; *) echo 'unknown resource' >&2; exit 2 ;; esac
    done
    [ "${HTTP_ONLY:-0}" = 0 ] || sites='http://www.youtube.com/ http://discord.com/'
    for site in $sites; do
        index=$((index + 1))
        "$PROBE" -interface "$WAN" -protocol "$protocol" -timeout "$probe_timeout" -mark "$MARK" -url "$site" > "$RESULTS/$protocol-$index" &
    done
    wait
    count=$index
    index=1
    while [ "$index" -le "$count" ]; do cat "$RESULTS/$protocol-$index"; index=$((index + 1)); done
}

build_args() {
    source=$1
    mode=$2
    candidate=$3
    set -- --qnum="$QUEUE" --pidfile="$PID" --user=nobody --fastpath-workaround=auto \
        --lua-init="@$ROOT/nfqws2/lua/zapret-lib.lua.gz" \
        --lua-init="@$ROOT/nfqws2/lua/zapret-antidpi.lua.gz" \
        --lua-init="@$ROOT/nfqws2/lua/zapret-auto.lua.gz" \
        --blob="quic_initial:@$ROOT/nfqws2/blobs/quic_initial.bin" \
        --blob="tls_clienthello:@$ROOT/nfqws2/blobs/tls_clienthello.bin"
    if [ -r "$ROOT/nfqws2/blobs/fs_quic_google.bin" ] && [ -r "$ROOT/nfqws2/blobs/fs_tls_max.bin" ]; then
        set -- "$@" --blob="fs_quic_google:@$ROOT/nfqws2/blobs/fs_quic_google.bin" --blob="fs_tls_max:@$ROOT/nfqws2/blobs/fs_tls_max.bin"
    fi
    if [ "$source" = custom ]; then
        [ -r "$candidate" ] || return 1
        while IFS= read -r arg || [ -n "$arg" ]; do
            case "$arg" in
                --in-range=-s5556|--in-range=x|--new|--filter-tcp=80|--filter-l7=tls|--filter-l7=http|--filter-l7=quic|--payload=http_req|--payload=empty|'--out-range=<s1'|'--out-range=s1<d1'|--filter-tcp=443|--filter-udp=443|--payload=tls_client_hello|--payload=quic_initial|--payload=empty,tls_client_hello|--filter-tcp=2053,2083,2087,2096,8443|--filter-udp=19294-19344,50000-50100|--filter-udp=1024-65535|--filter-l7=discord,stun|--filter-l7=unknown|--payload=discord_ip_discovery,stun|--payload=unknown|--out-range=-n2|--lua-desync=*)
                    set -- "$@" "$arg" ;;
                *) echo 'invalid candidate argument' >&2; return 1 ;;
            esac
        done < "$candidate"
    else
        set -- "$@" --filter-tcp=443 --payload=tls_client_hello \
            --lua-desync='fake:blob=tls_clienthello:tls_mod=rnd,dupsid,sni=fonts.google.com:tcp_seq=10000:strategy=1' \
            --lua-desync='multisplit:pos=1,midsld:seqovl=1:seqovl_pattern=tls_clienthello:tcp_ts_up:strategy=1'
        if [ "$mode" = tcp-quic ]; then
            set -- "$@" --new --filter-udp=443 --payload=quic_initial \
                --lua-desync='fake:blob=quic_initial:repeats=11'
        fi
    fi
    "$ENGINE" --dry-run "$@" >&2
    "$ENGINE" --daemon "$@" >/dev/null 2>&1
}

if [ "${1:-}" = cleanup ]; then cleanup; exit 0; fi
HTTP_ONLY=0
[ "${1:-}" != check-http ] || HTTP_ONLY=1
[ "${1:-}" = check ] || [ "${1:-}" = check-http ] || { echo 'usage: nfqws2-probe.sh check preset|custom tcp|tcp-quic candidate-file' >&2; exit 2; }
case "${2:-}" in preset|custom) ;; *) exit 2 ;; esac
case "${3:-}" in tcp|tcp-quic) ;; *) exit 2 ;; esac
[ -x "$ENGINE" ] && [ -x "$PROBE" ] || { echo 'probe tools missing' >&2; exit 1; }
ip route show default | grep -q "dev $WAN " || { echo 'WAN interface changed' >&2; exit 1; }
"$IPT" -j NFQUEUE -h 2>&1 | grep -q -- --queue-bypass || exit 1

trap cleanup EXIT HUP INT TERM
cleanup
build_args "$2" "$3" "${4:-/dev/null}"
# Router sleep implementations may accept integer seconds only.
if command -v usleep >/dev/null 2>&1; then
    usleep 100000
else
    sleep 1
fi
[ -f "$PID" ] || { echo 'probe engine did not start' >&2; exit 1; }
probe_pid=$(cat "$PID")
case "$probe_pid" in ''|*[!0-9]*) echo 'invalid diagnostic PID' >&2; exit 1;; esac
[ -r "/proc/$probe_pid/exe" ] && [ "$(readlink "/proc/$probe_pid/exe")" = "$ENGINE" ] || { echo 'diagnostic engine exited before probe' >&2; exit 1; }
rule -A tcp
if [ "$HTTP_ONLY" = 1 ] || grep -qx -- '--filter-tcp=80' "${4:-/dev/null}"; then rule -A tcp 80; fi
[ "$3" = tcp-quic ] && rule -A udp
timeout_seconds=${5:-5}
case "$timeout_seconds" in 2|3|4|5|6|7|8|9|10|11|12|13|14|15) ;; *) exit 2 ;; esac
if [ "$3" = tcp-quic ] && [ "$HTTP_ONLY" = 0 ]; then protocol=both; else protocol=tcp; fi
probe_sites "$protocol" "$timeout_seconds"
