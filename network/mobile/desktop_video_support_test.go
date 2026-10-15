//go:build integration

package mobile

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"testing"

	"tailscale.com/net/netns"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// DesktopVideoFixture is only exported in Go's augmented test package. It does
// not exist in either shipping helper. The fixture's host-side bridge maps the
// fixed overlay service ports to a separate input-disabled loopback engine.
func DesktopVideoFixture(t *testing.T, enginePort int) (*Node, string, func(string) error) {
	t.Helper()
	if enginePort < 1029 || enginePort > 65514 {
		t.Fatal("invalid isolated engine port")
	}
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control := httptest.NewServer(&testcontrol.Server{DERPMap: integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"), Logf: logger.Discard})
	t.Cleanup(control.Close)
	makeNode := func(name string) *Node {
		socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := socket.LocalAddr().(*net.UDPAddr).Port
		socket.Close()
		node, err := NewWithPort(t.TempDir(), name, "https://fixture.invalid", "", port)
		if err != nil {
			t.Fatal(err)
		}
		node.server.ControlURL = control.URL
		t.Cleanup(func() { node.Close() })
		return node
	}
	host := makeNode("desktop-video-host")
	if _, err := host.Start(); err != nil {
		t.Fatal(err)
	}
	ip, _ := host.server.TailscaleIPs()
	oldTCP, oldUDP := tcpPorts, udpPorts
	tcpPorts = []int{enginePort - 5, enginePort, enginePort + 2, enginePort + 21}
	udpPorts = []int{enginePort + 9, enginePort + 10, enginePort + 11}
	host.mu.Lock()
	err := host.bindPorts(ip.String(), "127.0.0.1", true, 48789-enginePort)
	host.exposed = err == nil
	host.mu.Unlock()
	tcpPorts, udpPorts = oldTCP, oldUDP
	if err != nil {
		t.Fatal(err)
	}
	client := makeNode("desktop-video-client")
	return client, ip.String(), func(string) error {
		peer, _ := client.server.TailscaleIPs()
		addresses, _ := json.Marshal([]string{peer.String()})
		return host.SetPeers(string(addresses))
	}
}
