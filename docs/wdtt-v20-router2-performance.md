# WDTT v20 router.2

Upstream remains v20, commit d450e132d2477a80d7079282c200ac3fb97ad0ae.
The reproducible router patch additionally:

- Pools pointers to fixed packet arrays instead of boxed slice headers. Oversized buffers are not retained in the pool.
- Rejects binary packets before converting them into strings for control-message parsing. ASCII worker-policy and update responses still follow the original parsers.
- Refreshes the DTLS reader deadline once per half timeout, rather than once per received packet. An idle read remains bounded by 15–30 seconds; cancellation still closes the connection. Keepalive and recovery logic remain upstream.

No change to worker count, packet ordering, encryption, pacing, server protocol or LAN routing.

## Evidence

Selected upstream protocol, update-message, TURN/session and SOCKS tests plus packet-pool size coverage passed on Windows amd64 with Go 1.26.8.
Packet-pool microbenchmark on the same laptop:

| Build | Time per get/put | Allocations | Bytes allocated |
| --- | ---: | ---: | ---: |
| router.1 | 53.77 ns | 1 | 24 |
| router.2 | 19.20 ns | 0 | 0 |

These numbers measure buffer handling, not end-to-end bandwidth. The reported 25–27 Mbit/s router download versus about 54 Mbit/s Android has not been reproduced or resolved by a bandwidth measurement. No promised speedup or CPU percentage follows from this benchmark.

The user declined repeated speed tests. Deployment must preserve Xray and device 192.168.0.4 and must not stop a running WDTT session without agreement. A stopped WDTT client may be replaced for its next normal start, after saving its previous binary and version.
