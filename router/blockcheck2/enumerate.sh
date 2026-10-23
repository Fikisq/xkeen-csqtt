#!/bin/sh
# Enumerate official blockcheck2 templates only. No network, engine or firewall operations.
set -f
TESTDIR=$(CDPATH= cd -- "$(dirname -- "$0")/standard" && pwd) || exit 1
export TESTDIR
UNAME=Linux IPV=4 IPVV= SCANLEVEL=force
MIN_TTL=1 MAX_TTL=12 MIN_AUTOTTL_DELTA=1 MAX_AUTOTTL_DELTA=0
FOOLINGS46_TCP='tcp_md5 badsum tcp_seq=-3000 tcp_seq=1000000 tcp_ack=-66000:tcp_ts_up tcp_ts=-600000'
HOSTFAKE=www.google.com
FAKE_REPEATS=6
contains() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }
extract_arg() { n=$1; shift; while [ "$n" -gt 1 ] && [ "$#" -gt 0 ]; do shift; n=$((n-1)); done; printf '%s' "${1:-}"; }
pktws_curl_test_update() {
    shift; shift
    n=$((n+1))
    # Bound hostile/unexpected expansion, but do not discard fooling variants
    # merely because upstream enumerates TTL variants first.
    [ "$n" -le 4096 ] || return 1
    printf '\036%s/%s\n' "$family" "$n"
    printf '%s\n' "$@"
    printf '\037\n'
    # Failure makes upstream enumerate all alternatives, without claiming success.
    return 1
}
for family in 20-multi 23-seqovl 24-syndata 25-fake 30-faked 35-hostfake 50-fake-multi 55-fake-faked 60-fake-hostfake 90-quic; do
    (
        n=0
        . "$TESTDIR/$family.sh"
        if [ "$family" = 90-quic ]; then pktws_check_http3 unused unused; else pktws_check_https_tls13 unused unused; fi
    ) || :
done
