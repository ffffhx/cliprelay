//go:build integration

package mobile

import (
	"bytes"
	"context"
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

// Exercises actual WireGuard/tsnet nodes and both directions of the local socket
// bridge. The coordinator and DERP are loopback fixtures; no user account or
// installed Tailscale daemon is used. This is not a cellular throughput test.
func TestEncryptedOverlayBridge(t *testing.T) {
	netns.SetEnabled(false)
	defer netns.SetEnabled(true)
	c := &testcontrol.Server{DERPMap: integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"), Logf: logger.Discard}
	httpServer := httptest.NewServer(c)
	defer httpServer.Close()
	makeNode := func(name string) *Node {
		n, err := New(t.TempDir(), name, "https://fixture.invalid", "")
		if err != nil {
			t.Fatal(err)
		}
		n.server.ControlURL = httpServer.URL
		t.Cleanup(func() { n.Close() })
		if _, err = n.Start(); err != nil {
			t.Fatal(err)
		}
		return n
	}
	host := makeNode("cliprelay-host")
	phone := makeNode("cliprelay-phone")
	other := makeNode("not-paired")
	hostIP, _ := host.server.TailscaleIPs()
	phoneIP, _ := phone.server.TailscaleIPs()
	peers, _ := json.Marshal([]string{phoneIP.String()})
	host.SetPeers(string(peers))
	peers, _ = json.Marshal([]string{hostIP.String()})
	phone.SetPeers(string(peers))
	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcp.Close()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	go func() {
		for {
			c, err := tcp.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	go func() {
		b := make([]byte, 65535)
		for {
			n, a, err := udp.ReadFrom(b)
			if err != nil {
				return
			}
			udp.WriteTo(b[:n], a)
		}
	}()
	oldTCP, oldUDP := tcpPorts, udpPorts
	tcpPorts = []int{tcp.Addr().(*net.TCPAddr).Port}
	udpPorts = []int{udp.LocalAddr().(*net.UDPAddr).Port}
	defer func() { tcpPorts = oldTCP; udpPorts = oldUDP }()
	if err = host.Expose(); err != nil {
		t.Fatal(err)
	}
	if err = phone.Forward(hostIP.String(), "127.0.0.2"); err != nil {
		t.Fatal(err)
	}
	for _, network := range []string{"tcp", "udp"} {
		port := tcpPorts[0]
		if network == "udp" {
			port = udpPorts[0]
		}
		conn, err := net.Dial(network, net.JoinHostPort("127.0.0.2", strconv.Itoa(port)))
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(15 * time.Second))
		payload := bytes.Repeat([]byte("ClipRelay"), 100)
		if _, err = conn.Write(payload); err != nil {
			t.Fatal(err)
		}
		response := make([]byte, len(payload))
		if _, err = io.ReadFull(conn, response); err != nil {
			t.Fatal(err)
		}
		conn.Close()
		if !bytes.Equal(payload, response) {
			t.Fatal("payload changed")
		}
		t.Logf("%s: native socket -> embedded node -> encrypted overlay -> host engine -> reply OK", network)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	blocked, err := other.server.Dial(ctx, "udp", net.JoinHostPort(hostIP.String(), strconv.Itoa(udpPorts[0])))
	if err == nil {
		defer blocked.Close()
		blocked.SetDeadline(time.Now().Add(400 * time.Millisecond))
		blocked.Write([]byte("unpaired"))
		b := make([]byte, 32)
		if _, err := blocked.Read(b); err == nil {
			t.Fatal("unpaired node reached host engine")
		}
	}
	t.Log("unpaired node rejected; host engine never returned its datagram")
	if err := phone.Close(); err != nil {
		t.Fatal(err)
	}
	if err := host.Close(); err != nil {
		t.Fatal(err)
	}
}
