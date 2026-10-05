package inputfocus

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strings"
	"time"
)

const discoveryPrefix = "CLIPRELAY_DISCOVER_V1 "

// Discovery is a hint only. The client obtains the UUID and checks its saved
// certificate before connecting; no credential or approval is broadcast.
func discoveryReply(packet []byte, name string) []byte {
	if !strings.HasPrefix(string(packet), discoveryPrefix) {
		return nil
	}
	nonce := strings.TrimPrefix(string(packet), discoveryPrefix)
	if !pairNonce.MatchString(nonce) {
		return nil
	}
	b, _ := json.Marshal(map[string]any{"protocol": "cliprelay.discover.v1", "nonce": nonce, "port": 48789, "name": name})
	return b
}

func serveLANDiscovery(ctx context.Context) error {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 47634})
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() { <-ctx.Done(); conn.Close() }()
	name, _ := os.Hostname()
	buffer := make([]byte, 256)
	// Limit total responses even when untrusted LAN hosts flood queries.
	window := time.Now()
	responses := 0
	for {
		n, remote, err := conn.ReadFromUDP(buffer)
		if err != nil {
			return err
		}
		if !remote.IP.IsPrivate() || remote.Port == 0 {
			continue
		}
		if time.Since(window) > time.Second {
			window = time.Now()
			responses = 0
		}
		if responses >= 20 {
			continue
		}
		response := discoveryReply(buffer[:n], name)
		if response == nil {
			continue
		}
		responses++
		_, _ = conn.WriteToUDP(response, remote)
	}
}
