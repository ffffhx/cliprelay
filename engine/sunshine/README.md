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
pending.

Android now observes the actual default network handle, including Wi-Fi-to-Wi-Fi
changes. A healthy stream keeps its connection. Network loss immediately releases
held input; two seconds without a newly received, presented frame also pauses
input. Recovery requires both a fresh presented frame and display metadata
requested after the pause, so a buffered picture cannot re-enable input. Display
and network pauses are independent. After six paused seconds the client attempts
authenticated route recovery, with a 20-second route-selection deadline and at
most two automatic recoveries per minute. Lifecycle pauses reset the observation
window. These policies have JVM coverage; actual Android handover, background/PiP
and input-release behavior still require device validation.

An isolated encrypted loopback test on Intel Quick Sync H.264 changed budgets
12 → 2 → 6 Mbps on the same connection, with capture generation unchanged.
Synthetic motion produced video payloads of 8.847 → 1.419 → 4.243 Mbps; confirmation
frame receipt took 31, 125 and 109 ms. The largest received-frame gap was 47 ms.
These are one-machine receipt measurements at 1280×720/30 fps, not Android
presentation or Internet measurements. The final 6 Mbps setting also survived
display reconstruction. Use `windows/tests/engine_control_test.py` with both
`--stream-client <engine-stream-client.exe>` and `--bitrate-test` to repeat this
test; it briefly displays a non-activating synthetic motion window. State-file
publication and reads tolerate brief Windows sharing conflicts without treating
them as a lost stream.

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
0.547 seconds in the latest test. This does not validate physical multi-monitor
switching, hotplug, Android presentation or Internet latency. Source bundles keep
the `engine/sunshine` and `scripts` layout so their prepare script can be used directly.

The development option `cliprelay_process_audio = enabled` attempts Windows
process-loopback capture for 48 kHz stereo. It is off by default while the host
mute controls are being integrated. On Windows build 20348 or later, it captures
rendering processes except the configured host process tree, independently of
endpoint mute and master gain. `cliprelay_audio_exclude_pid` defaults to 0 (the
engine itself); the ClipRelay service writes its own PID so its voice-injection
workers are excluded too. The engine requires a live ancestor, checks creation
times against reused parent PIDs, and holds the root handle while capturing.
Root exit invalidates readiness and capture. Invalid configuration never silently
becomes engine-only process capture. Custom applications launched under the
excluded tree are also excluded; ClipRelay's Desktop launches none. The new
path does not change endpoint routing, volume or format and skips Steam driver
installation/default-sink resetting. Unsupported systems/layouts use the existing
endpoint backend. After process capture starts, reinitialization retries that
same backend rather than falling back while a host might still be muted.

Each stream's optional `audio` object contains `capture` (`process`, `endpoint`,
or empty), `generation`, and `ready`. Readiness requires a fresh native capture
packet and an encoded Opus packet from that generation. It expires after two
seconds without such packets; old queued PCM, retired captures and disconnected
streams cannot renew it. The paired service validates and filters this state by
certificate owner. The host's `/v1/audio-mute` lease now requires the sole current
stream, binds its audio generation, and restores on loss of readiness. It uses
the desktop-user worker, independent expiry and durable recovery, with bounded
retry protection for canceled leases. Android now exposes the mute control in
the privacy menu, restores on leaving the foreground remote view, and refuses
renewal against a replaced audio generation. Device acceptance is still pending.

`windows/tests/audio_loopback.py --process` now uses the same `cliprelay_audio.h`
capture code as the engine, restricted to its own generated tone on an existing
non-default Steam virtual speaker. Native PCM amplitude was 0.005 before, during
and after endpoint mute, with settings restored. The complete engine build at
`c0db423f9642eb5a6f4e1123057966cf1214e2b1` also passed encrypted stream acceptance:
the receiver decoded Opus in memory and measured 0.005032555 in all three phases,
with the same stream and audio generation. No raw audio was saved. Run
`windows/tests/engine_control_test.py <engine-directory> --stream-client <receiver>
--audio-test <audio-loopback.exe>` to reproduce. The tone helper allows only its
own session and the exact fixture engine's capture session on the non-default
Steam speaker; unrelated sessions abort the experiment and restore mute.

This remains a development option. Native process-ancestry/lifetime tests pass
for default/self, a live parent, an unrelated process, an already exited parent
and exit of the held parent. A silent own-process capture remained healthy for
401 measured reads, with no nonzero samples. The complete host-ancestor engine
at `8f7a024f32cfe4027f70e26429343caacddb690d` passed the same encrypted test with
`--audio-host-root`: external tone amplitude was 0.005031733 throughout mute;
the sibling voice-worker tone measured 0 across 28 receiver measurements and
1152 packets. The previous engine failed this negative control at amplitude
0.005032555. The stream/audio generation remained unchanged, settings restored,
and the isolated host/engine exited. This validates synthetic process-tree
exclusion, not production microphone injection or SYSTEM-session behavior.
SYSTEM context, physical-speaker mute, other layouts, Android playback and the
installed pipeline remain unverified.

The host input path also supports an opt-in input epoch envelope, implemented in
`cliprelay_input.h`. It travels inside the existing encrypted GameStream input
transport, so the stream's authenticated identity remains authoritative. Its
16-byte header contains the normal big-endian payload length, little-endian
magic `0x4352494e`, a big-endian nonzero 32-bit epoch, an operation byte and three
zero reserved bytes. Operations 1/2 pause/resume; operation 3 encloses one complete
NV input packet, with the full envelope bounded to 144 bytes. Commands contain no
additional payload. Initial activation must be pause epoch 1; subsequent commands
alternate resume and pause with consecutive epochs. Invalid, repeated and delayed
commands cannot change the gate or perform another release.

Admission closes as soon as a valid command arrives. The input queue retains the
owning stream token and epoch, rechecks them before platform delivery and never
batches across tokens or epochs. Once activated, unwrapped legacy input is rejected
for that stream. The single input worker cancels delayed repeat/button/gamepad
tasks, releases tracked keys and buttons, neutralizes gamepads, cancels touch/pen
contacts and clears modifier/scroll state before acknowledging. The acknowledgment
means the platform release calls returned; it does not independently measure the
physical devices or override a local user's physically held keys. Old queued
input remains invalid after resume. Stream removal closes its token, including
queued work that still holds a shared pointer to it.

The pinned backend shares keyboard/mouse state, so epoch transitions require the
sole registered host stream at the worker boundary. A competing stream causes a
terminal failed gate without releasing another controller's keys. Clients must
end that stream on failure. No automatic resume is performed. Controllers should
also stop an operation if exclusivity is lost while it is in progress.

Authenticated `GET /api/cliprelay/input` reports each stream's owner, ID, epoch,
acknowledged epoch, enabled/paused/pending/closed/failed flags and exclusivity.
The paired service exposes read-only `/v1/input-state`, validates state consistency,
filters streams by the current mutual-TLS certificate and rechecks revocation after
the read. Neither HTTP endpoint can issue a native input command. Existing clients
that never activate the extension keep the legacy input path.

`input_test.cpp` exercises the packet/state/lifetime rules without platform input.
`input_integration_test.cpp` is copied into the upstream test target and exercises
the production queue with a fake backend and a keyboard-output sink. All twelve
keyboard, mouse, gamepad, touch, pen and guarded selection cases pass in
[build 38758839932](https://github.com/ffffhx/cliprelay/actions/runs/38758839932).
They include delayed left-button release across pause, coordinate-mode changes
and disconnect, a new press superseding a pending release, and both side buttons.
The optional
`engine_control_test.py --input-epochs --stream-client <receiver>` fixture verifies
encrypted pause/resume acknowledgments and display reconstruction while paused;
it does not send key, mouse or gamepad data. The same final engine also passes
`--native-input-epochs` with the complete desktop common core: six alternating
epochs receive host acknowledgment in 47–141 ms and local acknowledgment in
141–218 ms. Same-stream display reconstruction while paused takes 0.672 s.
These are local fixture results without video decoding or presentation.
The new desktop owner and display picker now join these native acknowledgments
with capture generation and actual presented-frame validation before resuming.
The final guarded host passes both a complete native receiver fixture (0.406 s
same-display reconstruction while paused) and the actual Qt desktop controller
fixture (0.703 s through presentation and input resume). Both keep the original
stream and disable physical input injection. Physical multi-monitor, hotplug,
managed GUI and installed hardware acceptance remain separate.

## macOS host overlay

The macOS host workflow applies `prepare_sunshine.py --macos-host` to the pinned
Sunshine source and its pinned libvirtualhid gitlink. This adds the display
catalog, actual capture identity and logical desktop geometry. Capture pixels
remain separate from CoreGraphics logical points, including negative desktop
origins and Retina scaling. Windows builds keep the original preparation path.

Every native mouse move, button edge and scroll carries the current capture
target. Input becomes active only after a real captured frame has been encoded.
Target versions distinguish preparation, active capture and cancellation; an old
target cannot be reactivated. Switching targets or closing the native mouse
releases its owned buttons at the previous target before accepting new input.
The overlay preserves fractional absolute coordinates and rejects non-finite
coordinates, invalid bounds and events without a target once targeting begins.

`macos_mouse_test.cpp` adds fourteen cases using the production CoreGraphics
backend with posting, cursor and display boundaries replaced. It also exercises
the production capture registry, video input transform and libvirtualhid adapter.
These tests do not inject system input or start capture. The original fourteen
mouse cases and twelve input integration cases pass on arm64 and x86_64 in
[build 38824743508](https://github.com/ffffhx/cliprelay/actions/runs/38824743508).
Both downloaded archives pass independent source, file inventory, architecture
and actual macOS 14.2 minimum-version checks.

The capture overlay keeps AVFoundation callbacks short: each output owns one
latest retained sample, a serial callback queue and an independent stop path.
The capture thread reads with a 100 ms budget, services stream controls on empty
polls and reinitializes after three seconds without a real frame. Display removal,
native mode changes and logical rearrangement are checked periodically. Native
screen-recording permission is rechecked with `CGPreflightScreenCaptureAccess`
on each geometry check and before dummy capture; the upstream platform flag
alone caches only startup permission. Dummy capture has the same bounded
first-frame wait. Stopping one
output detaches its delegate and drains its queue before releasing state; other
outputs keep running. This follows the documented
[AVFoundation callback queue contract](https://developer.apple.com/documentation/avfoundation/avcapturevideodataoutput/setsamplebufferdelegate(_:queue:)).

`macos_capture_test.mm` adds thirteen cases for actual CoreMedia sample lifetime,
latest-frame replacement, bounded waits, cancellation, callback draining, output
ownership and capture-loop deadlines. Only the capture session boundary is faked;
no screen is recorded. The workflow requires all thirty-nine cases within a
two-minute test-process deadline. Physical hotplug, capture permissions and
monitor behavior remain unverified, as does a complete Mac hosting application.
The app now has owned permission settings; host lifecycle remains separate work.

The engine handles `--cliprelay-permissions status` before configuration, logging,
capture or listener initialization. It returns one JSON object with current
`screenRecording` and `inputControl` preflights. Only the explicit
`request-screen` and `request-input` actions invoke their corresponding native
request API. Denial remains a false status; a completed request is never treated
as an implicit grant. Malformed reserved commands fail before normal startup.
`permissions_test.cpp` verifies this policy with injected callbacks, including
revocation, denied requests, malformed arguments and unavailable functions.

After signing, the packager runs four native status/invalid-command checks on
the actual installed engine and records `permission-tests.json`. These checks
never invoke a native permission request. They require clean JSON and unchanged
Sunshine and ClipRelay default state plus working directories. The engine archive includes
the command header, policy test and native checker source; the application
packager requires the permission-command receipt too.
Before signing, the engine receives the distinct `com.cliprelay.host-engine`
bundle identifier and the name `ClipRelay Host`. The packaged engine declares
this identity; macOS permission attribution when launched by the enclosing app
still requires runtime validation. Its bundle minimum system version is macOS
14.2, matching the native executable. Internal signatures
remain ad-hoc; this does not establish Developer ID distribution or notarization.

The Electron macOS packaging workflow accepts an explicit `host_engine_run_id`.
It requires a successful native host workflow with all forty-six tests, verifies
the archive checksum and every included source against that run's Git commit,
then stages the matching arm64 or x86_64 engine. The application packager checks
the pinned manifest, complete file inventory, included licenses, native machine
type, actual minimum OS and contained dependencies before and after packaging.
It also verifies the engine's signature using macOS `codesign` in both locations.
Packages containing the engine require macOS 14.2. A `host-engine-bundle-*.json`
receipt records the exact selection. The final packaged production Node owner
executes two read-only native permission queries and verifies child cleanup.
This does not enable hosting, grant permissions or validate actual streaming.

Mac host startup requires `CLIPRELAY_HOST_STATE_DIR` to name an existing,
canonical absolute directory owned by the current user with mode `0700`.
Invalid, missing, aliased or permissive roots fail before configuration/log
initialization. All platform app-data paths use this explicit root; the real
`HOME` is unchanged. File creation uses a private umask, and the initial apps
file receives owner-only permissions. Capture initialization never opens a
permission request itself; the explicit app settings flow owns those requests.

`--cliprelay-state check` validates the same admission rule without creating
files. The signed-engine packager requires twelve native state checks, including
real configuration/log initialization with an intentionally unknown command
that exits before capture, permissions or network initialization. The receipt
proves default application directories are unchanged and created state stays
private. The state header, policy test and native checker are included in the
archive, and application staging requires this receipt. Private application
configuration is verified separately in both complete application packages.

Actual Mac hosting also requires `CLIPRELAY_HOST_OWNER_PID` to match its direct
parent and stdin to be an idle pipe or connected Unix stream socket. A monitor
requests shutdown on EOF, unexpected input or parent death, even when another
process holds the pipe open. Cleanup has a ten-second hard deadline. The monitor
is joined on normal exit and never closes a descriptor it does not own. Native
self-restart exits instead of forking a supervisor; ClipRelay owns replacements.

`--cliprelay-owner check` and `--cliprelay-owner wait` exercise this ownership
without capture or listeners. Packaging requires seven native pipe/monitor and
private certificate-file tests
and sixteen signed-engine command/process cases, including owner exit/crash and
rejection of full startup without an owner. `/api/cliprelay/host` is a read-only,
authenticated Mac endpoint returning the actual engine PID, parent PID and
current system grants. An application owner must pin its certificate and match
both PIDs before treating the admin connection as its own engine; this endpoint
alone does not prove streaming or network readiness. Application lifecycle,
pairing and network integration remain separate work.

This patch and control code are GPL-3.0-only, matching the modified Sunshine
engine. Distribute the pinned upstream source reference, patch and added headers
with any modified engine binary.
