package inputfocus

import (
	winio "github.com/tailscale/go-winio"
	"net"
)

func relayPipe(_ string) (net.Listener, error) {
	// Only the installed SYSTEM service publishes locally. Its existing control
	// pipe separately authorizes the tray's operator SID. Never accept network users.
	return winio.ListenPipe(`\\.\pipe\ClipRelay.Remote.Relay.v1`, &winio.PipeConfig{
		SecurityDescriptor: "D:P(D;;GA;;;NU)(A;;GA;;;SY)", InputBufferSize: 16384, OutputBufferSize: 16384,
	})
}
