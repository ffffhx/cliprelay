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
