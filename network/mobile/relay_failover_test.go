//go:build integration

package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/envknob"
	"tailscale.com/net/netns"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// Force DERP inside this fixture so LAN hole-punching cannot conceal a broken
// relay path. Keep the same TCP socket open across an actual relay shutdown.
// Coordination stays online; this does not model loss of the entire primary VM.
func TestRelayOutagePreservesOpenConnection(t *testing.T) {
	// Suppress direct discovery but retain STUN, which measures relay health.
	envknob.SetenvForTest(t, "TS_DEBUG_NEVER_DIRECT_UDP", "true")
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	makeRelay := func(id int) (*tailcfg.DERPRegion, func()) {
		d := derpserver.New(key.NewNode(), logger.Discard)
		http := httptest.NewTLSServer(derpserver.Handler(d))
		stunAddress, stopSTUN := stuntest.Serve(t)
		stop := sync.OnceFunc(func() { d.Close(); http.Close(); stopSTUN() })
		t.Cleanup(stop)
		return &tailcfg.DERPRegion{RegionID: id, RegionCode: fmt.Sprintf("relay-%d", id), Nodes: []*tailcfg.DERPNode{{
			Name: fmt.Sprintf("node-%d", id), RegionID: id, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none",
			DERPPort: http.Listener.Addr().(*net.TCPAddr).Port, STUNPort: stunAddress.Port,
			InsecureForTests: true, STUNTestIP: "127.0.0.1",
		}}}, stop
	}
	primary, stopPrimary := makeRelay(901)
	backup, _ := makeRelay(902)
	control := httptest.NewServer(&testcontrol.Server{Logf: logger.Discard, DERPMap: &tailcfg.DERPMap{
		Regions:    map[int]*tailcfg.DERPRegion{901: primary, 902: backup},
		HomeParams: &tailcfg.DERPHomeParams{RegionScore: map[int]float64{901: 1, 902: 10000}},
	}})
	t.Cleanup(control.Close)
	makeNode := func(name string) *Node {
		n, err := New(t.TempDir(), name, "https://fixture.invalid", "")
		if err != nil {
			t.Fatal(err)
		}
		n.server.ControlURL = control.URL
		t.Cleanup(func() { n.Close() })
		if _, err := n.Start(); err != nil {
			t.Fatal(err)
		}
		return n
	}
	host, phone := makeNode("relay-host"), makeNode("relay-phone")
	// Initial fallback selection is deliberately random while the first latency
	// scan runs. Pin only the setup phase, then remove the pin BEFORE the outage.
	// Failover itself must remain automatic.
	for _, node := range []*Node{host, phone} {
		node.server.Sys().MagicSock.Get().DebugForcePreferDERP(primary.RegionID)
		node.server.Sys().MagicSock.Get().ReSTUN("relay-test-setup")
	}
	for _, node := range []*Node{host, phone} {
		deadline := time.Now().Add(20 * time.Second)
		for {
			client, _ := node.server.LocalClient()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			status, err := client.Status(ctx)
			cancel()
			if err == nil && status.Self.Relay == primary.RegionCode {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("primary relay setup did not settle")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	hostIP, _ := host.server.TailscaleIPs()
	phoneIP, _ := phone.server.TailscaleIPs()
	for _, item := range []struct {
		node *Node
		peer string
	}{{host, phoneIP.String()}, {phone, hostIP.String()}} {
		peers, _ := json.Marshal([]string{item.peer})
		if err := item.node.SetPeers(string(peers)); err != nil {
			t.Fatal(err)
		}
	}
	engine, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Close() })
	go func() {
		for {
			connection, err := engine.Accept()
			if err != nil {
				return
			}
			go func() { defer connection.Close(); io.Copy(connection, connection) }()
		}
	}()
	port := engine.Addr().(*net.TCPAddr).Port
	oldTCP, oldUDP := tcpPorts, udpPorts
	tcpPorts, udpPorts = []int{port}, nil
	t.Cleanup(func() { tcpPorts, udpPorts = oldTCP, oldUDP })
	if err := host.Expose(); err != nil {
		t.Fatal(err)
	}
	if err := phone.Forward(hostIP.String(), "127.120.0.3"); err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp4", net.JoinHostPort("127.120.0.3", strconv.Itoa(port)), 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	probe := func(payload string) {
		connection.SetDeadline(time.Now().Add(60 * time.Second))
		if _, err := io.WriteString(connection, payload); err != nil {
			t.Fatal(err)
		}
		actual := make([]byte, len(payload))
		if _, err := io.ReadFull(connection, actual); err != nil {
			t.Fatal(err)
		}
		if string(actual) != payload {
			t.Fatalf("payload changed: %q", actual)
		}
	}
	probe("before relay outage")
	for _, node := range []*Node{host, phone} {
		client, _ := node.server.LocalClient()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		status, err := client.Status(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if status.Self.Relay != primary.RegionCode {
			t.Fatalf("fixture did not use primary: %s", status.Self.Relay)
		}
		for _, peer := range status.Peer {
			if peer.Active && peer.CurAddr != "" {
				t.Fatal("fixture used direct UDP instead of the relay")
			}
		}
	}
	for _, node := range []*Node{host, phone} {
		node.server.Sys().MagicSock.Get().DebugForcePreferDERP(0)
	}
	start := time.Now()
	stopPrimary()
	probe("same TCP connection after primary shutdown")
	for _, node := range []*Node{host, phone} {
		client, _ := node.server.LocalClient()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		status, err := client.Status(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if status.Self.Relay != backup.RegionCode {
			t.Fatalf("did not fail over: %s", status.Self.Relay)
		}
	}
	t.Logf("Open encrypted TCP connection survived primary relay shutdown in %s", time.Since(start).Round(time.Millisecond))
}
