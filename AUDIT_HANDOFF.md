# XKeen UI / CSQTT handoff — 2026-09-25

## Update later on 2026-09-25

- The user's 168/163 Mbps Ookla result was Hysteria2, not CSQTT. They report CSQTT still at 3–5 Mbps. Do not cite 168/163 as CSQTT throughput.
- WDTT Plus SOCKS5 at `127.0.0.1:1088` returned public IP `31.77.146.181` directly. Xray access log shows `192.168.1.43` Speedtest endpoint `8.47.69.0:443` routed through `wdtt-plus` at 10:45:52 and 10:48:12, `sub-03` at 10:46:14, and `sub-02` after 10:48:21. The user's Speedtest UI reported `2.26.72.225` while WDTT Plus was selected; the exact reason for that displayed IP is not proven. Current global Xray fallback is `sub-02`, with no device route for 1.43. Do not claim WDTT itself exits via 2.26.72.225.
- Added authenticated manual-hash generation endpoints, buttons in CSQTT and WDTT Plus settings, WDTT Plus manual mode, and `/opt/bin/vk-manual-hashes.sh` for staged/active VK call ownership. Generated calls expire after 10 minutes if not applied. A panel binary with SHA-256 `f59a5304e0c6a9136540185362d811119b2694ff99bbe4a0b0e270b36d6decbb` and matching router scripts were installed. No VK calls were generated during deployment. Xray routing was left unchanged; CSQTT was stopped, WDTT Plus running, and router SOCKS5 egress still `31.77.146.181`.

## Independent audit 2026-09-25 11:17–11:48 UTC

- Egress proven with a temporary separate Xray instance (live rules untouched): `sub-01`/`sub-02` exit `2.26.72.225` (`finlandfikisq.duckdns.org`); `sub-03` and `wdtt-plus` exit `31.77.146.181` (`netherlandsfikisq.duckdns.org` is the CSQTT/WDTT VPS). A Speedtest showing `2.26.72.225` went through `sub-01`/`sub-02`, not WDTT. The Xray access log was truncated at 11:17 UTC, so the 10:45–10:48 entries survive only in the note above.
- Live Xray rules (`xray api lsrules`) equal the saved `00_config.json`: 12 rules, `VPN -> sub-02`.
- Baselines without VK: VPS to OVH 682 Mbps; router to VPS via VLESS `sub-03` to OVH 259 Mbps; router direct 280 Mbps; router-VPS RTT 57 ms.
- CSQTT Auto API: 27 workers/1 call gave 4.19 Mbps TCP (4×OVH, 11:31); 36 workers/2 calls gave 7.41 Mbps (11:38). Raw UDP from the VPS to the tunnel IP on the same calls delivered 9.79/10 and 29.35/30 Mbps (27 workers), and 9.62/10 and 29.03/30 Mbps (36 workers). Loss was about 4–6% at any rate; router RcvbufErrors, csqtt0 drops, and server csqtt1 drops did not increase. Tunnel capacity is at least 29 Mbps, so TCP is loss- and reorder-limited rather than capped at 4 Mbps. Upstream `shared/flow_frame.rs` releases TCP gaps after 12 ms while tunnel RTT varied from 62 to 182 ms.
- Manual-hash fixes deployed (backups `*.audit-bak-20260925`): a plain service stop no longer finishes applied manual calls; a restart or watchdog restart before saving no longer finishes the staged calls; the 10-minute expiry starts before the first `calls.start`, so killed generations are cleaned up. The new `release` action is used when switching to auto modes. VK `calls.forceFinish` is idempotent (a second finish returns `response: 1`).
- The router WDTT Plus client carries `router/wdtt-plus-client-v18.patch` (chunkSize 16->64, SOCKS limit 64->256). After the audit restart, one of 8 groups got VK `ANON_BLOCKED`, leaving 63/72 workers.
- CSQTT is left stopped with the original config (Auto JS, 126 workers).

## Current implementation

- Working source: `E:\cudy\XKeen-UI-CSQTT`.
- Remote: `https://github.com/redline-keen/XKeen-UI-CSQTT`; local HEAD `52ac9b183104aa9a4e5b475e42eb39bbd76411cc`.
- The live panel on `192.168.1.1` was built from this working tree. The local release binary at `E:\cudy\xkeen-lab\work\target\aarch64-unknown-linux-musl\release\xkeen-ui` has the same SHA-256 as `/opt/sbin/xkeen-ui` on the router: `bee008dc5ed227d05718523812bf88b333213039d87698e800ce5ac325533610`.
- The working tree has many **uncommitted and untracked** files. A fresh GitHub clone does not reproduce the live implementation. Run `git status --short` before reviewing or changing it.
- Original CSQTT v2.1.9 source: `E:\cudy\xkeen-lab\reference\amurcanov-csqtt-v2.1.9`, commit `446293aa2e873ac5323ef6fd2316d9b81d966c11`.
- Router native CSQTT client SHA-256 equals the local build `E:\cudy\xkeen-lab\work\csqtt-client-2.1.9`: `8182b8aea20b71584bf836f520e769a135dd9c6c62ad6c97e738095aca3fe3ab`.
- VPS `31.77.146.181` currently runs Docker image `csqtt:2.1.9` in host network mode; its Docker container is named `csqtt`. `systemctl is-active csqtt` reports inactive because the service is in Docker.

## Relevant source files

- Router launch and VK calls: `router/csqtt-run-219.sh`, `router/csqtt-api-calls.sh`, `router/csqtt-tun-fd.c`, `router/S99csqtt`.
- Built-in tunnel speed test: `router/csqtt-speedtest.sh`, `backend/src/csqtt.rs`, `frontend/src/components/modals/CoreManagement.tsx`.
- Xray routing and device bypass: `backend/src/xray_routes.rs`, `backend/src/device_bypass.rs`, `frontend/src/lib/xrayDeviceRouting.ts`.
- WDTT Plus is separate: `backend/src/wdtt_plus.rs`, `router/wdtt-plus-run.sh`, `frontend/src/components/modals/WdttPlusSettings.tsx`.

## Confirmed CSQTT findings

- Current router profile: Auto API, UDP, video obfuscation, Firefox fingerprint, MTU 1300, 27 workers, one VK call. All 27 workers were active in the client log.
- Android upstream uses the same defaults and one call for 27 workers. At 81 workers, Auto API creates three calls. Android also sets `CSQTT_EVENTS=1` and `RAYON_NUM_THREADS=2`; no evidence yet that either explains throughput.
- Initial router 12-stream tests through `csqtt0` repeatedly measured about 3.8–4.2 Mbps download and 9.7–11.1 Mbps upload. Client CPU was about 7% of one core. A later controlled sequence on 2026-09-25 yielded 7.53/14.24 Mbps immediately after restarting 27 workers (one new VK call), 3.44/8.59 Mbps at 36 workers (two new calls), 17.12/14.33 Mbps immediately after returning to 27 workers, and 20.73/7.59 Mbps about two minutes later on the **same** 27-worker call. `csqtt0` TX/RX drops and host UDP receive-buffer error delta remained zero. The short sequence does not show a monotonic post-start slowdown, but does show large variation between calls/time windows.
- A separate four-stream download from OVH through `csqtt0` was also slow: two 10 MiB requests took 33–46 seconds; two timed out at 60 seconds. This rules out Cloudflare as the only slow test destination. The test-file source is `https://proof.ovh.net/files/`.
- During the concurrent router test, VPS container CPU was about 3.8%, host UDP receive-buffer errors remained zero, and server `csqtt1` TX drops stayed at 2771 (no increase). No new CSQTT container log errors appeared during that test.
- The user's earlier roughly 100 Mbps result was on this same router with **81 workers**, not on Android with 27 workers. Different worker counts and times do not establish where throttling starts.
- A local fix to `router/csqtt-api-calls.sh` was installed on the router without changing Xray routes: Auto API now continues creating later calls if an earlier slot fails and immediately rejects invalid-token/account codes 4/5/18/27/28. The 27/36/27 test sequence above ran with this script. Router was left at 27 workers, one active call; Xray default route remained `sub-02` (VLESS) with no explicit CSQTT rule.
- VK/TURN shaping remains plausible, but is not proven by these measurements. Do not silently raise worker count above 36; the user wants further trials at 27 or 36, while retaining larger choices in the UI.

## Boundaries and next checks

- Preserve the current working Xray/Mihomo routing and WDTT Plus. Do not change routes merely to run CSQTT diagnostics.
- Compare matched 27/36-worker tests at the same time and endpoint, recording both client and server counters. Inspect active VK calls and server traffic without printing tokens, passwords, hashes, or full process command lines.
- A browser WebRTC ICE leak test was not completed: Browser Use policy blocked opening the local test URL. Router firewall inspection alone cannot prove the browser does not reveal the public router IP.
- Secrets and SSH private keys are elsewhere under `E:\cudy\router-backup` and in live router/VPS config. Do not bundle that directory or copy live config/log files into a prompt. Source-only keyword scan found no obvious embedded access token or private key, but review any archive before sharing.
# Update 2026-09-25: selective Xray routing and saved drafts

- User confirmed YouTube works after Debian 192.168.0.198 was excluded from router interception. Keep Debian direct: Finland routes YouTube back to this host, whose zapret2 needs direct WAN egress. Capturing Debian caused a Finland -> Debian -> Finland loop.
- Xray selectors now stage changes until Save/apply, with cancel and stale-config checks. JSON routing export/import is staged. Full existing configuration archives gain download/upload (16 MiB, validated tar paths and file entries); upload only adds an archive, restore remains explicit.
- Xray global direct now uses a source-IP capture set `xkeen_ui_device_capture`, persisted in `/opt/etc/xkeen/device_capture_xray.lst`. Explicit non-direct device routes are captured, all other sources bypass. Explicit device-direct also keeps the existing MAC bypass.
- `normalizeDevicePriority` keeps device service/fallback blocks ahead of general service/fallback rules, including global CSQTT/WDTT/direct. Device addition is always available in Xray UI. This update does not change Mihomo selector semantics.
- Init source snapshot: `router/S05xkeen-device-priority.sh`. Both S05xkeen and generated proxy.sh must be updated, otherwise NDM can regenerate old bypass rules. Router rollback backup: `/opt/etc/xkeen-backup/device-priority-20260925`.
- Preserve user changes made during work: latest global selection Hysteria2, direct devices .72, .53, .198, .144; .129 inherits selector. Do not revert to earlier VLESS snapshot.

## 2026-09-25 selector layout and latency update
- Xray and Mihomo device tabs remain outside the inner rule scroller; fixed overlap from sticky headers.
- Each Xray rule/main selector has its own header Ping button; card pings remain.
- Mihomo uses controller /proxies/{name}/delay with HTTPS GET to cp.cloudflare.com, including special outbounds; old node-ping backend no longer called by selectors.
- Unified node cards: min-h-22, identical responsive grid breakpoints, border/padding, corner latency; Mihomo reorder controls integrated in rule headers.
- Frontend + aarch64 musl release builds passed. Mihomo layout inspected using local mock without changing live core.
- Deployed /opt/sbin/xkeen-ui SHA256 51ecd317ce8e2cab75eca1e49be67abe51d119cad4359c007a9090a8ababdb02; prior binary /opt/etc/xkeen-backup/layout-20260925/xkeen-ui. Restarted panel only.
- Live Xray configuration hash unchanged across deploy: 181d2433a8c3ec2220af7fbcbbc4cc766a859f8ff727ba2a5d383aac28fed655.

## 2026-09-25 follow-up: route controls, subscriptions, GET probes
- User explicitly stopped VLESS XHTTP Mihomo tuning. Do not continue it.
- ChatGPT on phone .129 confirmed working by user; no live route or DNS settings changed during these diagnostics. Keep .144 on Happ and router bypass.
- Fixed addCustomRoute: seed direct device rules as direct instead of attempting @selector and rejecting entire global creation when any bypass device exists.
- New centered create-route dialogs in both cores, name first. Tabs/add-IP scroll with cards; separate save controls outside scroller.
- Mihomo now stages device/rule/selection edits, supports apply/cancel/export/import/backups. New mihomoRoutingBackup.ts handles routing sections plus selection metadata; credentials/proxy definitions excluded from route exports.
- Mihomo selectors render draft via context overlay instead of mutating live proxy store. Apply validates config then reloads controller, restores selected groups, updates device/global bypass with rollback.
- Mihomo node-ping now serialized isolated core + curl HTTP GET, equivalent to Xray probe mechanism. Does not change live selector. Controller URL-test was insufficient for requested GET behavior.
- Verified real GET on router: Finland Hysteria2 ~351ms, Netherlands VLESS ~582ms, TUIC ~233ms. XHTTP REALITY authentication failed; deliberately left alone per user.
- Subscription loader libc DNS lookup failed while BusyBox nslookup succeeded; added bounded /opt/bin/nslookup fallback with existing IP validation and HTTPS pinning. Corrected existing russianserver subscription allowLan=true in metadata JSON (saved prior file in route-controls-20260925).
- Added actual Mihomo provider refresh API (works while inactive); uses Clash.Meta UA, writes cache, validates and rolls back invalid nodes. Active frontend reloads after cache update. Xray dry-run subscription refresh now succeeds; real Xray node configuration was not replaced during diagnostics.
- Before deploy backup /opt/etc/xkeen-backup/route-controls-20260925/xkeen-ui and xray-subscription-url.

Final deployment: router /opt/sbin/xkeen-ui SHA256 be5490db71a83e025ac83288adfc419e656e329b168c7ebf6967c368adbde86e. Restarted S99xkeen-ui only. Xray config hash unchanged across deployment: bf73887c086a4910975df8d1ca4952be8ad27b7e9e4c5df7a756ef15c8721cf6. Verified real panel on port1000: new centered route dialog; creating Neural/ai-bundle route succeeds as draft despite direct devices. Cancelled diagnostic draft, no live routing change. Removed temporary panel PID18389 and /tmp/xkeen-ui-diag binary/log. ChatGPT working per user; cause of earlier outage unconfirmed.

2026-09-26 follow-up: User asked backup semantics, timestamp, Mihomo GET ping, cross-core route/IP migration. Deployed panel SHA256 48cd5491fcf0c6f55c27482d80aa8e60deca38f70305896719469f08cf0fca58. Existing binary preserved at /opt/etc/xkeen-backup/core-transfer-20260925/xkeen-ui. Live core remained Xray; Xray and Mihomo config hashes unchanged on deployment (4cc73881895b4bd187cf1b9c83f8b3c100f9d05aee4f2ba778ea9850d819c512 and 40608a3c5155faa879c78a8f80cdf41010bf3d50494565739afd4ba81659832b). Backup collector now includes xray-subscription-url, global_direct flags if present, Mihomo provider cache YAML. New backup 2026-09-26_00-10-14_xkeen-ui.tar size46592 created and shown in UI; older backups 22:43:15 and 23:45:24 panel UTC+3. Mihomo UI now stores only own GET probe history instead of mixing native Mihomo TCP delay history; GET label. API real probe for tuic returned success true delay233 kind HTTP GET via proxy. Cross-core switch now creates backup, transfers custom domain/GeoSite routes and device IP rules in target config, validates before switch, applies bypass after switch with rollback on error. Source/dest conversion tested offline against copies of current configs: Xray->Mihomo 3 IP; Mihomo->Xray 1 IP; both config parsers validated them. Did NOT perform live core switch. Node selections remain per-core because names/protocols can differ. Private diagnostic copies and remote temp configs removed. Worktree retains broader preexisting changes.
