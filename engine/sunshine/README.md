# ClipRelay Sunshine control extension

This directory contains the reproducible source patch for the Windows engine
pinned in `upstream.json`. It is development work: the installed engine and
`windows/remote-desktop/engine.json` still use the upstream release. The paired
Go control API, Android display picker, input pause and frame tracking are implemented
with local tests. The complete installed service and Android UI still need runtime validation before
this can be described as a completed multi-display feature.

Apply to a clean checkout using:

```
python scripts/prepare_sunshine.py path/to/Sunshine
```

The script checks the exact upstream commit and patch applicability and refuses
to overwrite existing source edits. The CI workflow builds a Windows AMD64
artifact; it has read-only repository permission and does not publish a release.
Sunshine's additional tray is disabled because ClipRelay owns the host tray.
The patch also gives NVENC object targets their transitive Boost include requirements so
the pinned FetchContent Boost works without unrelated system Boost headers.
The upstream service launcher also receives the transitive Boost includes needed
by its shared log-rotation header.

## Protocol 1

`GET /api/cliprelay/displays` returns the current capture state. Add `?refresh=1`
when opening or refreshing a picker to enumerate currently capturable outputs;
ordinary status polling does not create extra DXGI duplication sessions.

`POST /api/cliprelay/displays` accepts only `display` (the exact output ID),
`revision` (the snapshot revision), and `instance` (the engine process ID).
Existing administrator authentication and
CSRF protection apply. ClipRelay must proxy this through its paired mutual-TLS
control API, bind ownership to the request certificate, and keep administrator
credentials on the host. Do not expose administrator credentials to clients.

Selection is session-only and affects the shared capture source. Multiple
simultaneous clients consequently see the same display. Reordering outputs does
not reinterpret an ID as a numeric monitor index. If capture initialization
fails, the capture loop attempts to return to the previous available output.

The response distinguishes acceptance from completion:

- `revision` rejects requests made from stale snapshots.
- `instance` is regenerated when the engine process restarts, preventing a stale
  request from matching counters that have reset in a new process.
- `generation` changes when the capture object is replaced.
- `phase` is `idle`, `starting`, `switching`, or `active`.
- `capture` describes the actual initialized output, including its physical
  desktop rectangle. Negative desktop coordinates are preserved. An initialized
  rectangle alone does not mean a video frame has been encoded.
- `requestId`, `result`, and `error` report a pending, applied, or failed switch.
- Each entry in `streams` includes its paired certificate's DER SHA-256 owner,
  an engine-local stream ID, negotiated video dimensions, capture generation,
  and `firstFrame`: the first encoded real frame for that binding. Zero means
  unavailable. A dummy frame cannot establish readiness.

The client must filter to its current stream, match the engine instance and capture generation, and
wait until it has decoded/rendered that stream's frame boundary before enabling
input. Global `phase=active` is insufficient when multiple clients are present.
The service must filter other clients' stream entries and fail closed while
mapping targeted focus probes if the current capture cannot be established.
Frame numbers and stream IDs are local to a running engine, not persistent IDs.

`GET/POST /api/cliprelay/bitrate` is a per-stream control endpoint. POST requires
`instance`, `owner` (host-derived certificate fingerprint), `stream`, `revision`
and `budgetKbps` (500–150000). The budget includes audio/FEC/transport overhead,
using the same conversion as RTSP and respecting the host's maximum bitrate.
Each stream has its own request revision, result and `appliedFrame`; an accepted
request is confirmed only by a packet whose PTS follows the encoder update.
Display generation, transport, frame numbering and other clients are unchanged.
The confirmed rate survives display reconstruction. Encoder restarts cancel
unconfirmed updates; errors/timeouts attempt to restore the prior parameters.
Currently only the pinned FFmpeg Quick Sync backend advertises live support.
The paired service exposes `GET/POST /v1/bitrate`, derives the owner from mutual
TLS, validates ownership before forwarding and filters other clients' state.
Android uses that endpoint and waits for the applied frame to be presented;
unsupported hosts/encoders use the existing reconnect path. Runtime validation
of Android presentation, other codecs/GPUs and injected driver failures remains
pending. Network-type changes still use reconnect recovery.

An isolated encrypted loopback test on Intel Quick Sync H.264 changed budgets
12 → 2 → 6 Mbps on the same connection, with capture generation unchanged.
Synthetic motion produced video payloads of 8.845 → 1.388 → 4.207 Mbps; confirmation
frame receipt took 94, 141 and 78 ms. The largest received-frame gap was 47 ms.
These are one-machine receipt measurements at 1280×720/30 fps, not Android
presentation or Internet measurements. The final 6 Mbps setting also survived
display reconstruction. Use the native receiver's `--bitrate-test` fixture option
to repeat this test; it briefly displays a non-activating synthetic motion window.

Queued keyframes own their parameter-set replacement bytes so encoder teardown
cannot leave the sender referring to the old encoder's storage.

The paired Go service exposes `GET/POST /v1/displays`, filtering stream owners and
requiring the caller's current `stream` ID for selections. Its
`GET /v1/display-focus` accepts `instance`, `stream`, `generation`, rendered
`frame`, and normalized `x`/`y`. It removes encoder letterboxing, maps to the
actual physical display, and rejects a focus result if capture changes while
Windows UI Automation is answering. The legacy focus endpoint remains available
for older clients; it does not provide the new multi-display contract.

## Validation

`control_test.cpp` is a standalone C++23 test for the shared capture state. It
covers output reordering, hot-unplug, optimistic concurrency, stale encoder
callbacks, buffered/dummy packets, negative coordinates, independent stream
lifetimes, failure recovery and requests racing with capture initialization.

```
clang++ -std=c++23 -Wall -Wextra -Werror -pthread engine/sunshine/control_test.cpp -o control-test.exe
control-test.exe
```

The full engine build is separate from these tests. Actual switching, decoder
readiness and input mapping still need real Windows multi-monitor validation.
The extension reports attached capturable virtual displays but does not install
a virtual display driver.

`windows/tests/engine_control_test.py <artifact-directory>` runs six authenticated
HTTP checks against a separate loopback-only engine with temporary configuration.
Its optional `--stream-client <engine-stream-client.exe>` starts a temporary paired
receiver, switches the available outputs, and checks real encoded-frame boundaries
without reconnecting. Build that receiver with `windows/tests/build-engine-stream-client.ps1`
and an LLVM MinGW compiler plus an OpenSSL DLL. It receives and discards video,
records only counters, disables host input/audio capture, and never modifies the
installed service. Receipt tests do not verify Android decoding or presentation.

The full engine build and six real HTTP checks passed on Windows. An isolated
encrypted loopback stream on Intel Quick Sync preserved its connection and stream
ID across rebuilding the one attached display, receiving a new keyframe after
0.703 seconds in that single test. This does not validate physical multi-monitor
switching, hotplug, Android presentation or Internet latency. Source bundles keep
the `engine/sunshine` and `scripts` layout so their prepare script can be used directly.

This patch and control code are GPL-3.0-only, matching the modified Sunshine
engine. Distribute the pinned upstream source reference, patch and added header
with any modified engine binary.
