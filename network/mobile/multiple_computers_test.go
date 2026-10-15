//go:build integration

package mobile

import (
	"bytes"
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

// Four real userspace nodes and two loopback forwards. No production coordinator,
// user credentials, remote applications, or physical devices are involved.
func TestMultipleComputerChannelsStayIsolated(t *testing.T) {
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	c := &testcontrol.Server{DERPMap: integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"), Logf: logger.Discard}
	control := httptest.NewServer(c)
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
	hostA, hostB := makeNode("host-a"), makeNode("host-b")
	phoneA, phoneB := makeNode("phone-for-a"), makeNode("phone-for-b")
	allow := func(n, peer *Node) string {
		ip, _ := peer.server.TailscaleIPs()
		value, _ := json.Marshal([]string{ip.String()})
		if err := n.SetPeers(string(value)); err != nil {
			t.Fatal(err)
		}
		return ip.String()
	}
	allow(hostA, phoneA)
	allow(hostB, phoneB)
	ipA, ipB := allow(phoneA, hostA), allow(phoneB, hostB)

	listenerA, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listenerA.Close() })
	port := listenerA.Addr().(*net.TCPAddr).Port
	listenerB, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.2", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listenerB.Close() })
	serve := func(listener net.Listener, prefix string) {
		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
					return
				}
				go func() {
					defer connection.Close()
					connection.SetDeadline(time.Now().Add(20 * time.Second))
					buf := make([]byte, 4)
					if _, err := io.ReadFull(connection, buf); err == nil {
						connection.Write(append([]byte(prefix), buf...))
					}
				}()
			}
		}()
	}
	serve(listenerA, "A:")
	serve(listenerB, "B:")
	oldTCP, oldUDP := tcpPorts, udpPorts
	tcpPorts, udpPorts = []int{port}, nil
	t.Cleanup(func() { tcpPorts, udpPorts = oldTCP, oldUDP })
	for _, entry := range []struct {
		node            *Node
		ip, destination string
	}{
		{hostA, ipA, "127.0.0.1"}, {hostB, ipB, "127.0.0.2"},
	} {
		entry.node.mu.Lock()
		err := entry.node.bind(entry.ip, entry.destination, true)
		entry.node.exposed = err == nil
		entry.node.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := phoneA.Forward(ipA, "127.120.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := phoneB.Forward(ipB, "127.120.0.2"); err != nil {
		t.Fatal(err)
	}
	if err := phoneA.Forward(ipB, "127.120.0.3"); err == nil {
		t.Fatal("one pairing could forward to another computer")
	}
	probe := func(address, expected string) {
		connection, err := net.DialTimeout("tcp4", net.JoinHostPort(address, strconv.Itoa(port)), 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		connection.SetDeadline(time.Now().Add(20 * time.Second))
		if _, err := connection.Write([]byte("ping")); err != nil {
			t.Fatal(err)
		}
		actual := make([]byte, 6)
		if _, err := io.ReadFull(connection, actual); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(actual, []byte(expected)) {
			t.Fatalf("%s reached wrong computer: %q", address, actual)
		}
	}
	probe("127.120.0.1", "A:ping")
	probe("127.120.0.2", "B:ping")
	if err := phoneA.Close(); err != nil {
		t.Fatal(err)
	}
	probe("127.120.0.2", "B:ping")
	if connection, err := net.DialTimeout("tcp4", net.JoinHostPort("127.120.0.1", strconv.Itoa(port)), time.Second); err == nil {
		connection.Close()
		t.Fatal("removed computer's local listener remained open")
	}
	t.Log("Both encrypted channels routed to their own computers; removing A left B usable")
}
