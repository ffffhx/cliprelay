package ciaudiobridge

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"cliprelay/network/transport"
	"github.com/coder/websocket"
)

func identity(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	cert, key, err := Identity()
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	return pair, cert
}

func config(t *testing.T, own tls.Certificate, peer []byte, server bool) *tls.Config {
	t.Helper()
	result, err := TLSConfig(own, peer, server)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func wait(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}

type running struct {
	server  *Server
	client  Client
	cancel  context.CancelFunc
	done    chan error
	address string
}

func start(t *testing.T, targets []Target) *running {
	t.Helper()
	host, hostCert := identity(t)
	peer, peerCert := identity(t)
	server, err := NewServer(config(t, host, peerCert, true), targets)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	r := &running{server: server, cancel: cancel, done: make(chan error, 1), address: listener.Addr().String()}
	r.client = Client{Context: ctx, URL: "ws://" + r.address + "/bridge", TLS: config(t, peer, hostCert, false)}
	go func() { r.done <- server.Serve(ctx, listener) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-r.done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("server did not close all owned sockets")
		}
		if server.Counters().Active != 0 {
			t.Error("active authenticated route remains")
		}
	})
	return r
}

func tcpEcho(t *testing.T) (Target, *atomic.Int64) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int64
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	return Target{"tcp", listener.Addr().(*net.TCPAddr).Port}, &accepted
}

func udpEcho(t *testing.T) (Target, *atomic.Int64) {
	t.Helper()
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var received atomic.Int64
	t.Cleanup(func() { socket.Close() })
	if err := socket.(*net.UDPConn).SetWriteBuffer(128 * 1024); err != nil {
		t.Fatal(err)
	}
	go func() {
		buffer := make([]byte, 65535)
		for {
			n, source, err := socket.ReadFrom(buffer)
			if err != nil {
				return
			}
			received.Add(1)
			socket.WriteTo(buffer[:n], source)
		}
	}()
	return Target{"udp", socket.LocalAddr().(*net.UDPAddr).Port}, &received
}

func TestTCPAuthenticatesAndPreservesFullDuplexHalfClose(t *testing.T) {
	target, accepted := tcpEcho(t)
	r := start(t, []Target{target})
	address, _ := target.address()
	conn, err := r.client.DialContext(context.Background(), "tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	payload := bytes.Repeat([]byte("owned-fixture\x00\xff\n"), 128*1024)
	written := make(chan error, 1)
	go func() {
		_, err := conn.Write(payload)
		if err == nil {
			err = conn.(interface{ CloseWrite() error }).CloseWrite()
		}
		written <- err
	}()
	received, err := io.ReadAll(io.LimitReader(conn, int64(len(payload)+1)))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(received, payload) {
		t.Fatal("TCP payload or half-close changed")
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	if accepted.Load() != 1 || r.server.Counters().Authenticated != 1 {
		t.Fatal("unexpected backend admission")
	}
}

func TestUDPBoundarySizesAndIndependentConnections(t *testing.T) {
	target, received := udpEcho(t)
	r := start(t, []Target{target})
	address, _ := target.address()
	for channel := 0; channel < 2; channel++ {
		conn, err := r.client.DialContext(context.Background(), "udp", address)
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		for _, size := range []int{0, 1, 17, 1400, 8192, MaxDatagram} {
			payload := bytes.Repeat([]byte{byte(channel + size)}, size)
			if n, err := conn.Write(payload); err != nil || n != size {
				t.Fatalf("write size=%d n=%d err=%v", size, n, err)
			}
			buffer := make([]byte, MaxDatagram)
			n, err := conn.Read(buffer)
			if err != nil || n != size || !bytes.Equal(buffer[:n], payload) {
				t.Fatalf("packet boundary size=%d n=%d err=%v", size, n, err)
			}
		}
		conn.Close()
	}
	if received.Load() != 12 || r.server.Counters().BackendDials != 2 {
		t.Fatal("datagram loss or merged connection")
	}
}

func TestWrongAndMissingIdentitiesNeverReachBackend(t *testing.T) {
	target, accepted := tcpEcho(t)
	r := start(t, []Target{target})
	address, _ := target.address()
	wrong, wrongCert := identity(t)
	for _, name := range []string{"wrong-client", "missing-client", "wrong-server"} {
		t.Run(name, func(t *testing.T) {
			client := r.client
			client.TLS = r.client.TLS.Clone()
			switch name {
			case "wrong-client":
				client.TLS.Certificates = []tls.Certificate{wrong}
			case "missing-client":
				client.TLS.Certificates = nil
			case "wrong-server":
				client.TLS = config(t, r.client.TLS.Certificates[0], wrongCert, false)
			}
			conn, err := client.DialContext(context.Background(), "tcp", address)
			if err == nil {
				conn.Close()
				t.Fatal("untrusted route admitted")
			}
		})
	}
	wait(t, func() bool { return r.server.Counters().Active == 0 })
	if accepted.Load() != 0 || r.server.Counters().BackendDials != 0 {
		t.Fatal("backend opened before mutual authentication")
	}
}

func TestDisallowedTargetsNeverReachBackend(t *testing.T) {
	allowed, accepted := tcpEcho(t)
	blocked, other := tcpEcho(t)
	r := start(t, []Target{allowed})
	address, _ := blocked.address()
	if conn, err := r.client.DialContext(context.Background(), "tcp", address); err == nil {
		conn.Close()
		t.Fatal("non-allowlisted endpoint admitted")
	}
	for _, address := range []string{"localhost:80", "192.0.2.1:80", "127.0.0.1:0", "127.0.0.1:65536"} {
		if conn, err := r.client.DialContext(context.Background(), "tcp", address); err == nil {
			conn.Close()
			t.Fatal("invalid endpoint admitted")
		}
	}
	if accepted.Load() != 0 || other.Load() != 0 || r.server.Counters().BackendDials != 0 {
		t.Fatal("disallowed socket was dialed")
	}
}

func TestMalformedDatagramClosesWithoutForwarding(t *testing.T) {
	target, received := udpEcho(t)
	r := start(t, []Target{target})
	address, _ := target.address()
	conn, err := r.client.DialContext(context.Background(), "udp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxDatagram+1)
	if _, err = conn.(*DatagramConn).Conn.Write(header[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Read(make([]byte, MaxDatagram)); err == nil {
		t.Fatal("invalid packet left stream open")
	}
	wait(t, func() bool { return r.server.Counters().Active == 0 })
	if received.Load() != 0 {
		t.Fatal("invalid packet reached backend")
	}
}

func TestProductionUDPAdapterSurvivesDialContextCancellation(t *testing.T) {
	target, _ := udpEcho(t)
	r := start(t, []Target{target})
	address, _ := target.address()
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- transport.UDP(ctx, listener, r.client.DialContext, address, func(a net.Addr) bool { return a.(*net.UDPAddr).IP.IsLoopback() })
	}()
	client, err := net.Dial("udp4", listener.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	for _, payload := range [][]byte{[]byte("first"), bytes.Repeat([]byte{0x77}, 3000), []byte("last")} {
		if _, err = client.Write(payload); err != nil {
			t.Fatal(err)
		}
		buffer := make([]byte, 4096)
		n, err := client.Read(buffer)
		if err != nil || !bytes.Equal(payload, buffer[:n]) {
			t.Fatalf("production UDP adapter: %v", err)
		}
	}
	cancel()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forwarder cleanup timed out")
	}
	wait(t, func() bool { return r.server.Counters().Active == 0 })
	if r.server.Counters().BackendDials != 1 {
		t.Fatal("dial cancellation closed a healthy session")
	}
}

func TestCancellationReleasesSocketsAndUnauthenticatedSlots(t *testing.T) {
	target, _ := tcpEcho(t)
	r := start(t, []Target{target})
	connections := make([]*websocket.Conn, 0, MaxConnections)
	for range MaxConnections {
		ws, _, err := websocket.Dial(context.Background(), r.client.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, ws)
	}
	defer func() {
		for _, ws := range connections {
			ws.CloseNow()
		}
	}()
	ws, response, err := websocket.Dial(context.Background(), r.client.URL, nil)
	if err == nil {
		ws.CloseNow()
		t.Fatal("connection bound not enforced")
	}
	if response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatal("missing bounded rejection")
	}
	if r.server.Counters().BackendDials != 0 {
		t.Fatal("unauthenticated connection dialed backend")
	}
	r.cancel()
	wait(t, func() bool { return r.server.Counters().Active == 0 })
	listener, err := net.Listen("tcp4", r.address)
	if err != nil {
		t.Fatal("listener still bound", err)
	}
	listener.Close()
}
