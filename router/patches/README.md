# CSQTT 2.1.9 router call closure

`csqtt-2.1.9-router-call-closure.patch` applies to amurcanov/csqtt commit
`ace21228f46f056e4a2ba734f2ecb67361d401ad` (client version 2.1.9).
It is used only for the router ARM64 client. The panel's service script sets
`CSQTT_VK_CALLS_FILE=/opt/etc/csqtt/vk_js_calls` in Auto VK mode.

The client saves the call ID before requesting room creation. It attempts an
explicit `calls.forceFinish` at shutdown and removes the ID only after VK
confirms closure. The service retries closure of a retained ID before any new
start and refuses to start if VK still rejects it. Auto API and generated
manual calls also refuse new creation while earlier IDs remain unclosed.

This cannot guarantee cleanup if the account loses permission to finish its
own call. In that case the ID stays on disk and CSQTT must remain stopped
until the room is resolved.
