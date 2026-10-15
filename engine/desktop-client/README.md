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
Desktop on viewer exit. Resolution, rate and window mode are launch settings.

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
