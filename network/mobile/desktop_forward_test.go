//go:build integration

package mobile

import (
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// Real userspace nodes, on both sides of TCP and UDP. All listeners use literal
// 127.0.0.1 and independent port groups, including macOS with no loopback aliases.
func TestDesktopForwardLocalChannelsAndCleanup(t *testing.T) {
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
		n, err := NewWithPort(t.TempDir(), name, "https://fixture.invalid", "", port)
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
	hostA, hostB := makeNode("desktop-host-a"), makeNode("desktop-host-b")
	clientA, clientB := makeNode("desktop-client-a"), makeNode("desktop-client-b")
	serve := func(host *Node, label string) string {
		ip, _ := host.server.TailscaleIPs()
		for _, servicePort := range []int{48789, 48792} {
			listener, err := host.server.Listen("tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(servicePort)))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { listener.Close() })
			go func() {
				for {
					connection, err := listener.Accept()
					if err != nil {
						return
					}
					go func() {
						defer connection.Close()
						connection.SetDeadline(time.Now().Add(15 * time.Second))
						data := make([]byte, 4)
						if _, err := io.ReadFull(connection, data); err == nil {
							connection.Write(append([]byte(label), data...))
						}
					}()
				}
			}()
		}
		udp, err := host.server.ListenPacket("udp4", net.JoinHostPort(ip.String(), "48798"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { udp.Close() })
		go func() {
			buffer := make([]byte, 1024)
			for {
				count, address, err := udp.ReadFrom(buffer)
				if err != nil {
					return
				}
				udp.WriteTo(append([]byte(label), buffer[:count]...), address)
			}
		}()
		return ip.String()
	}
	ipA, ipB := serve(hostA, "A:"), serve(hostB, "B:")
	forward := func(client *Node, ip string) int {
		peers, _ := json.Marshal([]string{ip})
		if err := client.SetPeers(string(peers)); err != nil {
			t.Fatal(err)
		}
		base, err := client.ForwardLocal(ip)
		if err != nil {
			t.Fatal(err)
		}
		if !client.BridgesReady() {
			t.Fatal("local listeners are not ready")
		}
		return base
	}
	a, b := forward(clientA, ipA), forward(clientB, ipB)
	if a == b {
		t.Fatal("two clients share a port group")
	}
	if _, err := clientA.ForwardLocal(ipB); err == nil {
		t.Fatal("unpaired target was accepted")
	}
	probe := func(protocol string, base int, expected string) {
		port := base
		if protocol == "pairing" {
			protocol = "tcp"
			port += 3
		}
		if protocol == "udp" {
			port += 9
		}
		connection, err := net.DialTimeout(protocol+"4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		connection.SetDeadline(time.Now().Add(15 * time.Second))
		if _, err := connection.Write([]byte("ping")); err != nil {
			t.Fatal(err)
		}
		buffer := make([]byte, 6)
		if _, err := io.ReadFull(connection, buffer); err != nil {
			t.Fatal(err)
		}
		if string(buffer) != expected {
			t.Fatalf("wrong computer over %s: %q", protocol, buffer)
		}
	}
	for _, protocol := range []string{"tcp", "udp", "pairing"} {
		probe(protocol, a, "A:ping")
		probe(protocol, b, "B:ping")
	}
	clientA.Close()
	for _, protocol := range []string{"tcp", "udp", "pairing"} {
		probe(protocol, b, "B:ping")
	}
	for _, offset := range []int{-5, 0, 2, 3, 21} {
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(a+offset)))
		if err != nil {
			t.Fatal("closed client retained a TCP listener", offset, err)
		}
		listener.Close()
	}
	for _, offset := range []int{9, 10, 11} {
		listener, err := net.ListenPacket("udp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(a+offset)))
		if err != nil {
			t.Fatal("closed client retained a UDP listener", offset, err)
		}
		listener.Close()
	}
	t.Log("Two desktop port groups route real encrypted TCP/UDP independently; closing A releases all eight listeners and keeps B usable")
}
