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

The helper allocates one port group on literal `127.0.0.1`: relative to the returned
HTTP base port, HTTPS is -5, RTSP +2, paired control +21, video UDP +9, control UDP
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

Integration into the desktop controller UI is still pending. Only component
manifests advertising `embedded-network` support this mode. Network revocation,
pause and host changes must close the helper and the associated stream.
