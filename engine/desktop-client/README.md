# ClipRelay desktop streaming component

Pinned Moonlight Qt v6.2.0 (`de2467e433821664cdd2224aad8c89a625be1ad9`),
GPL-3.0-or-later. This directory contains the ClipRelay modifications, not a
separate proprietary implementation of Moonlight. Preserve LICENSE and the
corresponding-source archive when distributing the component.

`scripts/prepare_desktop_client.py SOURCE` verifies the exact upstream commit
and an unmodified application tree, then applies the patch and session importer.
The `Desktop Client Build` workflow builds the production Qt protocol probe,
runs real mutual TLS tests, and builds Windows x64 and macOS universal viewers.
`scripts/build_desktop_client.py SOURCE windows|macos` requires a fresh build
directory and upstream's Qt/compiler/dependency prerequisites.

The embedded viewer accepts only `--cliprelay-session`. Its owning desktop app
writes a four-byte big-endian payload length followed by bounded UTF-8 JSON to
the child's stdin pipe. Version 1 carries an already paired client certificate,
private key, client ID, exact host certificate, host/port and display options.
The pipe remains open for the lifetime of the session; EOF ends the viewer.
Do not pass this payload through argv, environment variables, files or logs.

Viewers advertising `session-events-v1` write fixed newline-delimited JSON to
stdout: `{"version":1,"event":"connected"}` after transport setup, followed by
at most one `{"version":1,"event":"ended","reason":"network"}`. Other reasons
are `pairing`, `host`, `user`, `parent` and `decoder`; the first terminal reason
wins. These messages contain no credentials or server diagnostics. `connected`
does not establish that a frame has rendered. An unknown exit, malformed event,
startup timeout or non-network failure never triggers automatic recovery.

Client identity is imported in memory, isolated from Moonlight settings. The
viewer uses only the paired HTTPS endpoint, rejects redirects and certificate
changes, never falls back to HTTP or silently pairs, and asks for all stream
encryption capabilities. It opens the host's Desktop entry, preserves another
running application, uses absolute mouse input and does not quit the host's
Desktop on viewer exit. Resolution, frame rate and window mode are launch settings;
the paired controller can also adjust bitrate during a supported active stream.

Build and protocol checks do not establish working video, hardware decoding,
input capture, macOS permissions, route handover or installed-service behavior.
Those remain runtime acceptance requirements. No viewer binary is checked in.

The desktop network helper is built separately by `Desktop Network Build` using
`scripts/build_desktop_network.py windows|macos --output DIRECTORY`. Its source is
`network/cmd/cliprelay-client-network` and `network/desktopclient`. It accepts one
bounded JSON initialization line over a pipe (version, HTTPS controlUrl, broker
hostname, one-use authKey and approved peerIP), followed only by `status` or
`shutdown` commands. EOF closes the node even while registration is pending.
The state-directory argument contains no enrollment credential. Private tsnet
node state persists there; the owning app must protect and manage that directory.
On Unix, an inherited connected Unix stream socket pair is also accepted, because
Node uses that transport for child stdio. Regular files, terminals, Internet
sockets and Unix datagrams are rejected. The owner flushes then closes the input
handle when ending the lease.

The helper allocates one port group on literal `127.0.0.1`: relative to the returned
HTTP base port, HTTPS is -5, RTSP +21, paired control +2, pairing bootstrap +3, video UDP +9, control UDP
+10 and audio UDP +11. Destination ports stay fixed at the existing host defaults.
`ready` means the node and local forwarding sockets are ready; it does not prove
that a remote desktop is online or that video is being presented. The helper
does not implement broker claims, approval, enrollment renewal or UI persistence.

The viewer envelope optionally accepts `overlay: true` only with literal
`127.0.0.1` and an unprivileged local base. `overlayPort` is the advertised engine
base (defaults to 48789). The separately pinned common streaming submodule maps
RTSP and all three media/control ports, rejects unexpected advertised ports and
forces 1024-byte remote packets. The encrypted RTSP session URL and exact host
certificate remain intact. Direct-mode envelopes remain compatible.

Only viewer manifests advertising `embedded-network` support this mode. Desktop
enrollment also requires a helper advertising `pairing-bootstrap`; earlier helpers
cannot forward the TLS approval endpoint. Network revocation, pause and host
changes close the helper and its associated stream. A replacement route requires
the old viewer to close before its replacement can start. The desktop supervisor
automatically resumes the same paired host on a new route after network loss,
preserving picture settings. It waits up to 90 seconds, makes at most eight
attempts with 0.5/1/2/5-second backoff, and resets the budget only after a connection
has stayed established for 15 seconds. Stop, pause, selection/identity changes and
revocation cancel the recovery intent. There is no background retry after these
actions. Older viewers without lifecycle events require a component update.

`windows/electron/mac/network-channel.cjs` implements the shared main-process
helper manager. It checks the packaged helper hash, validates enrollment before
launch, bounds child replies, enforces startup and heartbeat deadlines, and waits
for the previous child to close before another start. Its returned loopback route
has a fresh generation for each process; do not save transient ports in the
paired-host catalog. Lost listeners, a changed port or owner cancellation withdraw
the route before cleanup.

Desktop enrollment is now wired into the shared Windows/Mac pairing UI through
`network-broker.cjs`, `network-catalog.cjs`, `network-controller.cjs` and
`routed-store.cjs`. Enter the host's eight-digit code, confirm the six-character
network identity on the host, then confirm the twelve-character TLS pairing
identity. Broker HTTPS uses normal certificate verification and rejects
redirects. The credential-derived device ID, approved broker peer ID and paired
host certificate are bound separately. Credentials use Electron safeStorage;
the renderer receives public status only. Saved hosts contain no transient
loopback ports. Each computer retains independent node state, pause and removal.

Route generations invalidate old clipboard transfers and viewer leases, including
local port reuse. A temporary broker outage preserves an existing route; explicit
revocation or identity mismatch closes it. A previously paired direct TLS address
can remain a fallback during a temporary external outage. Pausing the external
record, removing it, or observing revocation blocks that fallback. Removing a record
only removes local access; revoke the authorization on the controlled computer.

`scripts/package_windows.ps1 -NetworkArtifact DIRECTORY` stages the verified
helper beside `remote-viewer`; the installer preserves the complete manifest,
license, notices and corresponding network source. The macOS build accepts
`CLIPRELAY_NETWORK_HELPER_ARTIFACT`; its workflow can fetch a successful Desktop
Network Build run using `desktop_network_run_id`. Both Mac app architectures
include the universal helper. Runtime packages are development artifacts until
the combined Windows host installation, operator approval, desktop UI, actual
cross-network streaming and update acceptance have passed. Component tests and
local encrypted forwarding do not establish those acceptance results.

The enrollment revision `e9b59165514e49b070496603f5a02f64a15d8ec9` passes
[Desktop Network Build 38699780231](https://github.com/ffffhx/cliprelay/actions/runs/38699780231)
on Windows, macOS and Linux. This includes 43 desktop enrollment/ownership/route
cases on each platform, real encrypted two-peer TCP/UDP forwarding, and 13 helper
manager cases with the actual Windows and Mac binaries. Local Electron 44.4.3
passes 26 manager/controller cases, actual Go-broker interoperability, and
safeStorage identity/credential reload. A test CA chain is used for HTTPS tests;
production certificate verification stays enabled. The owner allows eight seconds
for shutdown because pinned tsnet cleanup can consume five seconds; route access
is withdrawn immediately, and a delayed normal-exit regression covers this race.

[Electron macOS build 38699781428](https://github.com/ffffhx/cliprelay/actions/runs/38699781428)
packages both app architectures with the verified universal viewer and helper.
Each downloaded archive matches 23 application sources, 1845 viewer files, four
network component files and 163 relative framework links. Windows staging matches
19 application sources, 292 viewer files and four network files. These checks do
not constitute production installation, physical Mac, new UI interaction or
end-to-end WAN streaming acceptance.

Desktop recovery is built in [component run 38710965221](https://github.com/ffffhx/cliprelay/actions/runs/38710965221).
The actual Windows supervisor and packaged viewer recover after terminating an
isolated encrypted network fixture and rebuilding its route on a different port.
Both viewer processes exit normally; their render rates are 29.91 and 29.97 FPS.
The replacement route is ready 4,922 ms before native transport setup completes;
this is a local fixture measurement, not WAN or first-frame latency. Final direct
regression renders 29.82 FPS and exits on parent EOF in 344 ms. No input/audio or
production installation is exercised. The first acceptance attempt exposed a
generic `-1` ENet disconnect; the pinned common patch now reports a distinct
transport-loss code without treating allocation/protocol failures as network loss.

The supervisor is tested with actual child processes for retry limits, stable
budget reset, delayed cleanup, port reuse, cancellation during identity unlock,
revocation/direct-fallback suppression, malformed events and native startup timeout.
49 local Node and actual Electron cases pass; the broader desktop CI runs on
Windows, macOS and Linux. These checks do not establish desktop UI interaction,
external enrollment-to-video, public relay streaming or physical platform coverage.

The viewer also supports the optional `presentation-events-v1` capability. The
desktop owner negotiates it by adding `telemetry: true` to the credential envelope;
renderer-provided launch options cannot enable it. Legacy envelopes still receive
only the two lifecycle events. An opted-in connected session emits at most five
`progress` records per second with received/rendered frame numbers, rendered
dimensions and the elapsed time since either frame number advanced. No video
pixels, keys, addresses or diagnostic strings enter this protocol.

Network frame numbers travel through FFmpeg's `AV_CODEC_FLAG_COPY_OPAQUE`, rather
than being inferred from the decode queue, which can lose alignment after decoder
drops. Windows D3D11/DXVA2 report only successful presentation submissions; this
does not measure the physical panel. Mac Metal uses the drawable's presentation
callback and requires a positive presentation time. Unknown frame identities,
failed or occluded presentation, stale callbacks, and renderers without a hook
cannot advance the reported boundary. Older FFmpeg versions without opaque
propagation and Metal versions before macOS 10.15.4 report no presented frame.

The owner validates bounded counters and geometry, advances frame ages using its
own monotonic clock, and rejects data from a disconnected process or obsolete
route. Repeating a frozen frame never makes it fresh again. Progress output is
nonblocking: if the owner stops consuming the pipe, the viewer reaches normal
session cleanup instead of blocking its input thread behind a write. This is a
foundation for display/bitrate confirmation; display switching still requires an
input pause/release acknowledgment and capture-generation validation before input
can resume. Those controls are not enabled by this telemetry capability alone.
Frame ages include native age and time since the owner's observation; they do
not measure an unknown backlog before the first observation. A future control
handshake must establish a new feedback boundary before relying on freshness.

[Component build 38732237555](https://github.com/ffffhx/cliprelay/actions/runs/38732237555)
passes ten actual Qt protocol groups and builds Windows and universal Mac viewers.
Downloaded artifacts match 292 Windows and 1845 Mac manifest files, seven extension
files and all sixteen changed/new upstream application sources. The new Windows
viewer, supervised by the production JavaScript owner, reports 24 progress samples
in an isolated HEVC 720p30 session; rendered frame numbers advance from 14 to 152,
rendering reaches 30.05 FPS, and parent EOF exits normally in 313 ms with the host
stream released. Keyboard, mouse, gamepad and audio remain disabled in that fixture.

[Desktop regression 38732557168](https://github.com/ffffhx/cliprelay/actions/runs/38732557168)
passes 85 enrollment/ownership/viewer cases on each of Windows, Mac and Linux,
plus the existing file, terminal and actual helper checks. Local Node and actual
Electron runtimes each pass 60 targeted cases. These are component/runtime checks;
the complete packages described below now include this presentation capability.
Managed desktop UI acceptance remains pending.

Windows and Mac now expose live bitrate adjustment in the paired desktop window.
The main-process controller binds each operation to the current viewer process,
route, paired certificate, engine instance and sole certificate-owned stream.
The renderer sends only a fresh view token and a 1,000–100,000 Kbps budget; the
controller derives the target and revision from pinned mutual-TLS metadata.
Multiple streams, unsupported encoders, stale metadata or frozen presentation
disable adjustment. Confirmed budgets are retained for automatic recovery.

An HTTP acceptance is not a displayed-frame confirmation. The controller waits
for the matching request and budget to be applied, then for the native rendered
frame to reach the host's encoded-frame boundary and advance beyond the frame at
submission. Lost replies cause read-only observation, never automatic resubmission;
after 15 seconds the result is unconfirmed. Route or target changes invalidate the
old operation. The UI preserves edits while polling and distinguishes rejection,
superseding changes and uncertain results. These bitrate controls do not enable
display switching, which still needs the input pause/release handshake above.

The production JavaScript controller, paired Go handlers, packaged Windows viewer
and isolated Sunshine encoder pass a direct HEVC 720p30 runtime check. In one
unchanged stream, budgets of 12, 2 and 6 Mbps are confirmed after 328, 265 and 282 ms;
the corresponding video targets are 8,908, 1,268 and 4,148 Kbps. The viewer renders
29.89 FPS and exits normally 296 ms after parent EOF; the host releases the stream.
These are local confirmation times and encoder targets, not WAN latency or measured
network throughput. Input and audio were disabled; physical panel output was not
measured. The native fixture uses production protocol handlers with temporary
credentials passed over a pipe and does not replace the installed application.

[Desktop regression 38735847276](https://github.com/ffffhx/cliprelay/actions/runs/38735847276)
passes 86 enrollment/ownership/viewer cases and 11 bitrate protocol/UI cases on
each of Windows, Mac and Linux, plus existing file, terminal and native helper
checks. Local Node and Electron runtimes each pass 72 targeted cases; Electron
runs as Node and the UI cases use a DOM fixture, so neither proves GUI acceptance.
[Windows complete package 38735855339](https://github.com/ffffhx/cliprelay/actions/runs/38735855339)
passes disposable installation, independent process lifetime, SYSTEM service pipe
and backend exit-on-pipe-close checks.
[Mac complete packages 38735862748](https://github.com/ffffhx/cliprelay/actions/runs/38735862748)
build both architectures. Downloaded packages are checked against the tested
application sources, pinned viewer/helper manifests and terminal vendor hashes;
all 680 Windows package files match the archive manifest.
Each Mac package matches 40 application sources, 1,845 viewer files, four helper
files and 163 relative framework links. These remain development artifacts;
managed UI, installed hardware streaming and public WAN acceptance are pending.

The common input sender now has an optional `cliprelayInputEpochs` configuration
field and owner-only command/acknowledgment APIs. When enabled, input starts
blocked. Every public producer is gated before changing cached state; transitions
clear queued input and mouse/controller/sensor/pen batches. Holders retain their
original epoch, including split text, and cannot consume newer shared batches.
The UTF-8 control-drain wait can be canceled without holding the epoch mutex.
Packets use the host's authenticated envelope while retaining their original
channel and reliability. A command return confirms local gating and transport
submission; the owner must verify matching host state before acknowledging it.
Only an acknowledged even epoch reopens local admission. Errors keep it blocked.

`scripts/test_desktop_input.py <patched-source> --output <executable>` exercises
the real producers, queue and sender with an in-memory transport. Its ten
scenarios cover all 20 public producers, full-queue cleanup, failed commands,
late mouse/controller/sensor batches, recycled controllers after queue overflow,
pen coalescing, cancellation of text waits
and legacy compatibility.

The optional session envelope now accepts `inputEpochs: true` only alongside
presentation telemetry. The owning process sends fixed 16-byte `CRIC` frames:
version 1, operation 1 (pause), 2 (resume) or 3 (verified host acknowledgment),
two zero bytes, a big-endian nonzero epoch and four zero bytes. Buffering is
limited to four commands; incomplete frames expire after two seconds. Local
`input` events distinguish `submitted` from `acknowledged`. EOF, invalid input,
failed native commands and output backpressure use the normal cleanup path.

The SDL loop applies commands before dispatching further input. It clears held
state and queued input events, cancels touch/gamepad timers and rechecks physical
state before reopening admission. Keys, buttons, contacts and axes held across
resume must be released or neutral before becoming new remote input. Blocked
keyboard modifiers are removed from subsequent key events. Input timers execute
on the SDL thread, preventing a delayed callback from crossing a pause. Device,
window, decoder and quit events remain available while input is paused.

The manifest advertises `input-epochs-v1`. The desktop owner opts in only after
the paired host confirms input-state support; older hosts retain the lease-only
envelope. The owner starts paused and requires native submission, the exact
exclusive host stream/epoch acknowledgment and native acknowledgment separately.
Initial input opens only after a frame from the current capture is presented.
Subsequent resume also rechecks the expected capture generation, dimensions and
frame boundary after the host acknowledgment. EOF, invalid local events, revoked
pairing, route changes and timeouts cancel the pending operation and close the
old native lease. The Windows/Mac display picker now uses this owner to pause,
submit one stream/epoch/revision-bound display selection and await matching
capture generation, encoded frame and actual presentation before resuming.
An uncertain POST is observed without resending; timeout or binding loss ends
the viewer without reopening input. Renderer requests carry only a view token
and a display from the current list, never a host address or input epoch.

[Input component build 38755514829](https://github.com/ffffhx/cliprelay/actions/runs/38755514829)
passes ten native queue scenarios, eight held-state/timer scenarios, six SDL
adapter scenarios, fourteen Qt protocol/TLS groups and seven paired JavaScript
protocol groups. SDL tests use the production adapter with a real SDL virtual
controller and dummy video, with UI/native transport boundaries stubbed; the
native queue tests exercise the production core separately. The JavaScript
groups also pass locally in Node and Electron running as Node.

Windows and universal Mac components build successfully. Downloaded artifacts
match all 294 Windows and 1,847 Mac manifest files, copied extensions and applied
Qt/common source patches. The Windows build exposed a `max` macro collision,
now fixed and covered by a header coexistence check. A separate regression
ensures synthetic touch mouse releases cannot consume a physical mouse's held
state. [Owner component build 38760732369](https://github.com/ffffhx/cliprelay/actions/runs/38760732369)
also passes the 30 paired input/owner cases and builds both platforms; all 294
Windows and 1,847 Mac files and corresponding sources have been verified.
The full application component pins now select this viewer and guarded host
build 38758839932. Windows complete build 38763184608 passes disposable install,
independent process and pipe-lifetime checks; all 704 packaged files, including
148 host-engine files, match their manifests and expected sources. Mac complete
build 38763191710 passes for arm64 and x64; each downloaded archive matches the
application sources, 1,847 viewer files, four network files and 163 internal links.

The final Windows Qt viewer, production StreamViewer/InputSession/DisplayController,
paired Go handlers and isolated final host pass the input/display runtime fixture:
pause epoch 3, encoded frame 140, presented frame 142, then resume epoch 4, within
703 ms on the same stream. Live 12/2/6 Mbps changes also pass; parent EOF closes
the viewer in 344 ms and releases the host stream. Host physical input and audio
are disabled in this fixture. It reconstructs the available single display,
so physical multi-monitor, hotplug, managed GUI and WAN acceptance remain.
Run `desktop_viewer_native.py --telemetry --control-fixture <paired Go fixture>
--input-epochs` with the verified engine and viewer artifacts. Local control/UI
tests are `desktop-display.test.cjs` and `desktop-display-ui.test.cjs`.

Manual input pause is now an explicit main-process intent. The owned UI sends
only its current view token and a boolean. Pausing can proceed while video is
stale; explicit resume requires fresh metadata and a newly presented frame.
Display switching preserves this intent, including a manual pause requested
while an automatic switch is already waiting for its new picture. A paused
switch confirms presentation without issuing a native resume command.

The intent survives route recovery. A new native child starts at paused epoch 1
and cannot use a legacy input fallback. Only a fully acknowledged explicit resume
clears the intent; cancellation cannot clear it for a replacement child. Ending
the remote session discards the intent. The combined Electron checks now pass
71 cases; the three-platform run is 38766017479. The complete native runtime
fixture verifies frames advancing while manually paused, same-stream display
reconstruction, old-child cleanup, a new stream remaining paused and explicit
resume of that new stream. This is an owned loopback route replacement, not a
real physical network outage. No physical input is injected.

The manual-pause complete packages have also been downloaded and verified:
Windows run 38766024045 (706 files, including 148 engine files) and Mac run
38766031990 (arm64/x64). Windows disposable installation, independent processes
and pipe lifetime checks pass. See `desktop-pause-artifacts.json`.

The desktop privacy panel now uses the existing paired `/v1/privacy` API. Its
main-process controller generates the lease identifier and binds explicit intent
to one authenticated host instance and stream. Renderer requests contain only a
view token and a boolean. A single loop serializes start, status, renewal and stop;
renewal acknowledgments are bounded by a monotonic deadline measured from request
dispatch. An expired or cancelled intent cannot become active from a late reply.
Presentation loss, local restore, revocation and session/route replacement stop
renewals and request restoration. A new child never inherits privacy intent.
Best-effort cleanup uses the old certificate pin and exact old lease; independent
host/worker expiry remains necessary when the app exits or a route is lost.

The combined Electron checks pass 83 cases. `TestPrivacyDesktopControllerInterop`
runs this controller against production Go display/privacy handlers with real
mutual TLS, including lease renewal and route cleanup. Its display source and
mask worker are simulated, so it does not claim physical screen acceptance.
The unchanged C# worker also passes its eight lifecycle/recovery scenarios.
Desktop session-end lock and wake controls remain to be added.

Privacy source commit `b1ff746d97e9728d45aed2de3872d23f5827403a` passes the
three-platform run 38769236478. Complete packages Windows 38769246502 and Mac
38769254186 have been downloaded and verified against that commit, including
all three privacy modules. Windows has 712 verified files and passes disposable
installation, independent process and pipe lifetime checks. Both Mac architectures
retain the verified native viewer/network components and 163 internal links.
See `.tools/uu-parity/desktop-privacy-artifacts.json`; physical GUI/mask acceptance
remains pending and the developer machine's installed application is unchanged.

Desktop audio mute now uses `/v1/audio-mute` independently of privacy masks. Its
strict display parser retains process-audio readiness and generation metadata;
only the main process chooses the stream, generation and random lease. A queued
click cannot retarget a replacement capture. Audio generation/readiness changes,
stale video and route/session replacement stop the old lease without reacquiring.
Both foreground controls share serialized lifecycle, monotonic expiry and cleanup
in `foreground-lease.cjs`. Audio restoration additionally requires `recovering` to
be false, so inactive-but-recovering state and HTTP 503 recovery-pending responses
cannot be displayed as restored or enable a new mute.

The 98 combined Electron cases pass, including the existing privacy suite after
the shared lifecycle extraction. Go privacy/audio tests pass 19 top-level groups
and 46 test events without skips, including real worker status/EOF. The new real
mutual-TLS fixture connects both desktop controllers to production Go handlers,
checks pending recovery, independent controls, capture-generation replacement
and route cleanup. Its audio/capture/mask workers are simulated. The unchanged
C# audio worker passes 26 lifecycle cases with fake endpoints. No physical output
is muted, and the existing default-off process-capture setting remains unchanged;
SYSTEM/cross-session and physical audio acceptance are still required.

Audio-mute commit `4bdc4f1bfc7a6c77bd0fc865b859674ec3a3521a` passes all three
platforms in run 38772563670. Windows complete run 38772572796 passes installation,
independent process and pipe lifetime checks; all 720 archive files are verified.
Mac complete run 38772579368 passes arm64/x64, with both downloads verified against
the exact source, 1,847 viewer files, four network files and 163 internal links.
The shared foreground lifecycle and all audio/privacy modules are included in
each package. Evidence is in `.tools/uu-parity/desktop-audio-mute-artifacts.json`.

Desktop session-end lock uses a host-owned one-shot arrangement, separate from
the foreground privacy/audio leases. A confirmed arrangement survives closing
the viewer, panel or app. The desktop sends only status, arm and explicit disarm;
the host decides stream end and commits once after its idle grace and final
stream check. Renderer commands contain only an owned view token and boolean.
Fresh presented video and the host's `cancelProtected` capability are required
to arm. Old hosts display an update requirement.

Cancellation receipts are bounded and retained for two minutes, with a reserved
slot for the active intent. Lost cancellation replies stay pending. A lost OS
commit reply cannot be reported as successful cancellation; requested and
historically confirmed lock are distinct. Worker restart retires the old intent.
Tests reproduce and fix those boundaries, including a production Go/desktop
mutual-TLS fixture with simulated workstation and stream lifetime. The 113
combined Electron cases, 33 Go groups/72 pass events and 10 C# policy cases pass
locally without failures or skips. No physical lock was requested.

Product commit `cf90ab7ce2ccf7d36cd904bf9b0ab653b2ffd621` is followed by the
test-only IPv4 fixture correction `3cb7768030317f9b9a99b32e584e6793a3499959`.
Three-platform run 38777974356 includes Linux race checks. Windows complete run
38777981669 passes disposable installation and ownership checks; all 726 archive
files and the embedded host's final build revision are verified. Mac complete
run 38777376973 uses the product commit; the only later change is outside the
application, in the fixture request. Both Mac archives match final application
sources, 1,847 viewer files, four network files and 163 internal links. Android
regression run 38777341666 also passes. Evidence is recorded in
`.tools/uu-parity/desktop-session-lock-artifacts.json`. Real GUI, installed
SYSTEM-to-user locking and physical lock/unlock acceptance remain pending.
