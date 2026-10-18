#!/bin/sh
# Fail-open nfqws2 for the selected trial device and marked Xray direct outbound.
set -eu

ROOT=/opt/etc/xkeen/nfqws2-stage
LOG="$ROOT/nfqws2.log"
umask 077
log_event() {
    printf '%s [INFO] %s\n' "$(date -u '+%Y/%m/%d %H:%M:%S')" "$*" >> "$LOG"
}
log_error() {
    printf '%s [ERROR] %s\n' "$(date -u '+%Y/%m/%d %H:%M:%S')" "$*" >> "$LOG"
    echo "$*" >&2
}
if [ ! -e "$LOG" ]; then
    log_event 'Service journal enabled; packet debug is disabled'
fi
trap 'result=$?; if [ "$result" -ne 0 ]; then log_event "Command ${1:-unknown} failed (exit $result)"; fi' 0
BIN="$ROOT/engine"
PID="$ROOT/nfqws2.pid"
PROFILE="$ROOT/profile"
CUSTOM="$ROOT/custom-strategy.args"
QUEUE=330
CLIENT=''
LAN=br0
WAN=${NFQWS_WAN:-$(ip -4 route show default | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')}
COMMENT=xkeen_nfqws2_canary
GLOBAL_COMMENT=xkeen_nfqws2_global
MARK=832
GLOBAL_ENABLED="$ROOT/global-enabled"
XRAY_CONFIG=/opt/etc/xray/configs/00_config.json
JQ=/opt/bin/jq
IPT=/opt/sbin/iptables
if [ -x "$JQ" ] && [ -r "$XRAY_CONFIG" ]; then
    CLIENT=$("$JQ" -r '[.routing.rules[]? | select((.ruleTag // "") | endswith(":VPN|nfqws2")) | select(.outboundTag == "direct") | .sourceIP[]? | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))][0] // empty' "$XRAY_CONFIG")
fi

queue_rule() {
    kind=$1
    operation=$2
    protocol=$3
    capture=${4:-configured}
    ports=443
    if [ "$capture" = full ] || { [ "$capture" = configured ] && [ -s "$CUSTOM" ] && grep -qx -- '--filter-udp=1024-65535' "$CUSTOM"; }; then
        if [ "$protocol" = tcp ]; then ports=443,2053,2083,2087,2096,8443; else ports=443,1024:65535; fi
    fi
    if [ "$kind" = trial ]; then
        [ -n "$CLIENT" ] || return 1
        set -- -t mangle "$operation" FORWARD -i "$LAN" -o "$WAN" -s "$CLIENT/32" -p "$protocol"
        comment=$COMMENT
    else
        set -- -t mangle "$operation" OUTPUT -o "$WAN" -m mark --mark "$MARK/0xffffffff" -p "$protocol"
        comment=$GLOBAL_COMMENT
    fi
    if [ "$ports" = 443 ]; then set -- "$@" --dport 443; else set -- "$@" -m multiport --dports "$ports"; fi
    "$IPT" "$@" -m comment --comment "$comment" -j NFQUEUE --queue-num "$QUEUE" --queue-bypass
}

trial_rule() { queue_rule trial "$@"; }
global_rule() { queue_rule global "$@"; }

udp_enabled() {
    [ "$(profile)" = tcp-quic ] || { [ -s "$CUSTOM" ] && grep -qx -- '--filter-udp=1024-65535' "$CUSTOM"; }
}

trial_enabled() {
    [ -x "$JQ" ] && [ -r "$XRAY_CONFIG" ] || return 1
    [ -n "$CLIENT" ]
}

global_enabled() {
    [ -f "$GLOBAL_ENABLED" ] && [ -x "$JQ" ] && [ -r "$XRAY_CONFIG" ] || return 1
    "$JQ" -e 'any(.outbounds[]?;
      .tag == "nfqws-direct" and .protocol == "freedom" and
      .streamSettings.sockopt.mark == 832)' "$XRAY_CONFIG" >/dev/null
}

remove_rules() {
    kind=$1
    for protocol in tcp udp; do
      for capture in legacy full; do
        while "${kind}_rule" -C "$protocol" "$capture" >/dev/null 2>&1; do
            "${kind}_rule" -D "$protocol" "$capture"
        done
      done
    done
}

ensure_rule() {
    kind=$1
    protocol=$2
    if ! "${kind}_rule" -C "$protocol" >/dev/null 2>&1; then
        "${kind}_rule" -A "$protocol"
    fi
}

alive() {
    [ -f "$PID" ] || return 1
    pid=$(cat "$PID")
    [ -r "/proc/$pid/exe" ] || return 1
    [ "$(readlink "/proc/$pid/exe")" = "$BIN" ]
}

profile() {
    if [ -s "$CUSTOM" ]; then
        if grep -qx -- '--filter-udp=443' "$CUSTOM"; then echo tcp-quic; else echo tcp; fi
        return 0
    fi
    value=$(cat "$PROFILE" 2>/dev/null || echo tcp-quic)
    case "$value" in tcp|tcp-quic) echo "$value" ;; *) return 1 ;; esac
}

run_engine() {
    action=$1
    selected=$(profile) || { log_error 'invalid nfqws2 profile'; return 1; }
    set -- \
        --qnum="$QUEUE" --pidfile="$PID" --user=nobody --fastpath-workaround=auto \
        --lua-init="@$ROOT/nfqws2/lua/zapret-lib.lua.gz" \
        --lua-init="@$ROOT/nfqws2/lua/zapret-antidpi.lua.gz" \
        --blob="quic_initial:@$ROOT/nfqws2/blobs/quic_initial.bin" \
        --blob="tls_clienthello:@$ROOT/nfqws2/blobs/tls_clienthello.bin"
    if [ -s "$CUSTOM" ]; then
        while IFS= read -r arg || [ -n "$arg" ]; do
            case "$arg" in
                --new|--filter-tcp=443|--filter-udp=443|--payload=tls_client_hello|--payload=quic_initial|--payload=empty,tls_client_hello|--filter-tcp=2053,2083,2087,2096,8443|--filter-udp=19294-19344,50000-50100|--filter-udp=1024-65535|--filter-l7=discord,stun|--filter-l7=unknown|--payload=discord_ip_discovery,stun|--payload=unknown|--out-range=-n2|--lua-desync=*)
                    set -- "$@" "$arg" ;;
                *) log_error 'invalid custom strategy argument'; return 1 ;;
            esac
        done < "$CUSTOM"
    else
        set -- "$@" \
            --filter-tcp=443 --payload=tls_client_hello \
            --lua-desync='fake:blob=tls_clienthello:tls_mod=rnd,dupsid,sni=fonts.google.com:tcp_seq=10000:strategy=1' \
            --lua-desync='multisplit:pos=1,midsld:seqovl=1:seqovl_pattern=tls_clienthello:tcp_ts_up:strategy=1'
        if [ "$selected" = tcp-quic ]; then
            set -- "$@" --new --filter-udp=443 --payload=quic_initial \
                --lua-desync='fake:blob=quic_initial:repeats=11'
        fi
    fi
    if "$BIN" "$action" "$@" >> "$LOG" 2>&1; then
        return 0
    else
        result=$?
        tail -n 8 "$LOG" >&2
        return "$result"
    fi
}

case "${1:-}" in
    dry-run)
        run_engine --dry-run >/dev/null
        echo 'nfqws2 parameters valid; no traffic rules changed'
        ;;
    start|start-trial)
        [ -x "$BIN" ] || { log_error 'nfqws2 engine is missing'; exit 1; }
        # Never silently fall back to intercepting all devices or interfaces.
        [ -n "$WAN" ] && ip -4 route show default | awk -v wan="$WAN" '{for (i = 1; i <= NF; i++) if ($i == "dev" && $(i + 1) == wan) found = 1} END {exit !found}' || { log_error 'WAN interface not found'; exit 1; }
        "$IPT" -j NFQUEUE -h 2>&1 | grep -q -- --queue-bypass || { log_error 'NFQUEUE fail-open is unavailable'; exit 1; }
        selected=$(profile) || { log_error 'invalid nfqws2 profile'; exit 1; }
        trial=0
        global=0
        if [ "$1" = start-trial ] || trial_enabled; then trial=1; fi
        if global_enabled; then global=1; fi
        [ "$trial" -eq 1 ] || [ "$global" -eq 1 ] || { log_error 'nfqws2 is not selected in routing'; exit 1; }
        if ! alive; then
          log_event "Starting engine (profile=$selected)"
          run_engine --dry-run >/dev/null
          run_engine --daemon
          n=0
          while ! alive && [ "$n" -lt 10 ]; do
            if command -v usleep >/dev/null 2>&1; then usleep 100000; else sleep 1; fi
            n=$((n+1))
          done
          alive || { log_error 'nfqws2 did not start'; exit 1; }
          log_event 'Engine started'
        fi
        for protocol in tcp udp; do
            [ "$protocol" = tcp ] || udp_enabled || continue
            if [ "$trial" -eq 1 ]; then ensure_rule trial "$protocol"; fi
            if [ "$global" -eq 1 ]; then ensure_rule global "$protocol"; fi
        done
        if [ "$trial" -eq 0 ] || ! udp_enabled; then
            while trial_rule -C udp >/dev/null 2>&1; do trial_rule -D udp; done
        fi
        if [ "$global" -eq 0 ] || ! udp_enabled; then
            while global_rule -C udp >/dev/null 2>&1; do global_rule -D udp; done
        fi
        if [ "$trial" -eq 0 ]; then remove_rules trial; fi
        if [ "$global" -eq 0 ]; then remove_rules global; fi
        echo "nfqws2 active (trial=$trial global=$global; fail-open)"
        ;;
    stop-trial)
        log_event 'Stopping trial interception'
        remove_rules trial
        if ! global_enabled && alive; then kill "$(cat "$PID")"; fi
        echo 'nfqws2 trial stopped'
        ;;
    stop)
        log_event 'Stopping engine and interception'
        remove_rules trial
        remove_rules global
        if alive; then
            kill "$(cat "$PID")"
            sleep 1
        fi
        echo 'nfqws2 canary stopped'
        ;;
    status)
        if alive; then echo 'running'; else echo 'stopped'; fi
        echo "profile $(profile || echo invalid)"
        for protocol in tcp udp; do
            trial_rule -C "$protocol" >/dev/null 2>&1 && echo "$protocol trial queue active" || true
            global_rule -C "$protocol" >/dev/null 2>&1 && echo "$protocol global queue active" || true
        done
        ;;
    *) echo "usage: $0 {start|start-trial|stop-trial|stop|status|dry-run}" >&2; exit 2 ;;
esac
