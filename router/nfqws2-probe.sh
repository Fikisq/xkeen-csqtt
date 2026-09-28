#!/bin/sh
# Isolated diagnostic NFQUEUE. Only sockets explicitly marked 833 can enter it.
set -eu

ROOT=/opt/etc/xkeen/nfqws2-stage
ENGINE="$ROOT/engine"
PROBE="$ROOT/probe"
PID="$ROOT/probe.pid"
IPT=/opt/sbin/iptables
WAN=eth2.2
MARK=833
QUEUE=331
COMMENT=xkeen_nfqws2_probe
RESULTS="$ROOT/probe-results-$$"

rule() {
    "$IPT" -t mangle "$1" OUTPUT -o "$WAN" -m mark --mark "$MARK/0xffffffff" \
        -p "$2" --dport 443 -m comment --comment "$COMMENT" \
        -j NFQUEUE --queue-num "$QUEUE" --queue-bypass
}

cleanup() {
    for protocol in tcp udp; do
        while rule -C "$protocol" >/dev/null 2>&1; do rule -D "$protocol"; done
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
    mkdir -m 700 -p "$RESULTS"
    index=0
    for site in https://www.youtube.com/generate_204 https://discord.com/ https://www.instagram.com/; do
        index=$((index + 1))
        "$PROBE" -protocol "$protocol" -mark "$MARK" -url "$site" > "$RESULTS/$protocol-$index" &
    done
    wait
    for index in 1 2 3; do cat "$RESULTS/$protocol-$index"; done
}

build_args() {
    source=$1
    mode=$2
    candidate=$3
    set -- --qnum="$QUEUE" --pidfile="$PID" --user=nobody --fastpath-workaround=auto \
        --lua-init="@$ROOT/nfqws2/lua/zapret-lib.lua.gz" \
        --lua-init="@$ROOT/nfqws2/lua/zapret-antidpi.lua.gz" \
        --blob="quic_initial:@$ROOT/nfqws2/blobs/quic_initial.bin" \
        --blob="tls_clienthello:@$ROOT/nfqws2/blobs/tls_clienthello.bin"
    if [ "$source" = custom ]; then
        [ -r "$candidate" ] || return 1
        while IFS= read -r arg || [ -n "$arg" ]; do
            case "$arg" in
                --new|--filter-tcp=443|--filter-udp=443|--payload=tls_client_hello|--payload=quic_initial|--lua-desync=*)
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
    "$ENGINE" --dry-run "$@" >/dev/null
    "$ENGINE" --daemon "$@" >/dev/null 2>&1
}

if [ "${1:-}" = cleanup ]; then cleanup; exit 0; fi
[ "${1:-}" = check ] || { echo 'usage: nfqws2-probe.sh check preset|custom tcp|tcp-quic candidate-file' >&2; exit 2; }
case "${2:-}" in preset|custom) ;; *) exit 2 ;; esac
case "${3:-}" in tcp|tcp-quic) ;; *) exit 2 ;; esac
[ -x "$ENGINE" ] && [ -x "$PROBE" ] || { echo 'probe tools missing' >&2; exit 1; }
ip route show default | grep -q "dev $WAN " || { echo 'WAN interface changed' >&2; exit 1; }
"$IPT" -j NFQUEUE -h 2>&1 | grep -q -- --queue-bypass || exit 1

trap cleanup EXIT HUP INT TERM
cleanup
build_args "$2" "$3" "${4:-/dev/null}"
sleep 1
[ -f "$PID" ] || { echo 'probe engine did not start' >&2; exit 1; }
rule -A tcp
[ "$3" = tcp-quic ] && rule -A udp
probe_sites tcp
if [ "$3" = tcp-quic ]; then
    probe_sites h3
fi
