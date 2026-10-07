# Auto VK for APK 2.5.0 on the router

Original APK SHA256: b2049cb1e4a9cd4c4da40befe80a7317c3ccda583a1427d05ae46f9ce7a6ea83.
The original native executable is unchanged. The router launcher supplies its existing Android control interface.

## Evidence and implementation

Saved APK decompilation `ny2.java:1409–1421` sends `VK_JS_BOOTSTRAP:` followed by standard base64 JSON containing `token`. The new launcher constructs JSON with jq reading the private token file, without passing the token in command arguments. The FIFO remains open after bootstrap.

`ny2.java:412–443` sends `FINISH_VK_CALLS` then `STOP` before waiting for the native process. The supervisor now does the same on service termination, keeping helpers alive during a 60-second native grace period, then using the existing bounded signal fallback. Previously the retained shell received TERM and interrupted the native child directly.

The APK event parser `i23.java:173–180` exposes CAPTCHA_REQUEST mode, redirect_uri and session_token. The adapter persists fresh captcha state with private permissions and clears it on CAPTCHA_DONE/STOPPED and a new launch. The panel accepts only HTTPS VK captcha URLs. A user-completed success_token is sent as `CAPTCHA_RESULT|...`, matching `ny2.java:579–580` and `vq.java` interception of captchaNotRobot.check. A stale session or unsafe/oversized control value is rejected; FIFO writes are nonblocking and bounded.

Automatic browser capture of the captcha result is not implemented. If a challenge appears, the panel exposes the VK page and a manual result field. This is not Android WebView parity.

## Verification / deployment on 2026-10-07

- TypeScript and frontend build passed; ARM64 panel and native-event adapter built successfully.
- Shell syntax checks passed. An isolated WSL mock verified bootstrap decoding, open FIFO, finish-before-stop command order and supervisor exit. No real VK request was made by this test.
- An isolated test of the ARM64 event helper on the actual router verified CAPTCHA_REQUEST persistence and CAPTCHA_DONE cleanup using synthetic events. It did not create calls, change routing or contact VK. Stop command writing is bounded separately so a full control FIFO cannot prevent the shutdown grace timer from starting.
- Panel, launcher, service and adapter installed with backups on the router and E:. The original CSQTT executable was not replaced, and the current manual/Auto API selection was not changed. Existing Xray PID 27446 and protected router files were preserved during installation; Office device 192.168.0.4 remains direct/full bypass.
- The user changed router configuration during preparation; installation preserved the latest config instead of restoring an older snapshot.
- Auto VK account authentication, a real captcha, native call completion and end-to-end traffic in this mode have not been verified with the user's account. UI availability and build/mock results do not establish those outcomes.

## Limits

The original native interface does not expose proven durable created-call IDs. Graceful native cleanup is supported, but a crash, forced kill or power loss cannot guarantee call cleanup. Join hashes must never be written into the older actual-call-ID cleanup file. VK rate limits, account restrictions and invalid tokens remain service-side conditions.

Separately, WDTT was returned to the backed-up v20-router.1 and restarted at the user's request. Xray and routing were untouched. The router.2 changes reduced allocation in a microbenchmark but did not improve the user's bandwidth/CPU measurements and are not the installed client.
