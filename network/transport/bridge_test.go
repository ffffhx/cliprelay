package transport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestUDPRecoversLostListenerAndRebindFailure(t *testing.T) {
	echo, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buffer := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buffer)
			if err != nil {
				return
			}
			echo.WriteTo(buffer[:n], addr)
		}
	}()
	initial, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := initial.LocalAddr().String()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var binds atomic.Int32
	states := make(chan bool, 16)
	done := make(chan struct{})
	go func() {
		defer close(done)
		RecoveringUDP(ctx, initial, func() (net.PacketConn, error) {
			if binds.Add(1) == 1 {
				return nil, errors.New("interface not ready")
			}
			return net.ListenPacket("udp4", address)
		}, (&net.Dialer{}).DialContext, echo.LocalAddr().String(), allowAll,
			func(ready bool, _ error) { states <- ready })
	}()
	waitReady := func() {
		t.Helper()
		deadline := time.After(4 * time.Second)
		for {
			select {
			case ready := <-states:
				if ready {
					return
				}
			case <-deadline:
				t.Fatal("forwarding port did not recover")
			}
		}
	}
	exchange := func() {
		t.Helper()
		client, err := net.Dial("udp4", address)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		client.SetDeadline(time.Now().Add(2 * time.Second))
		client.Write([]byte("stream handshake"))
		buffer := make([]byte, 64)
		n, err := client.Read(buffer)
		if err != nil || string(buffer[:n]) != "stream handshake" {
			t.Fatalf("round trip: %q, %v", buffer[:n], err)
		}
	}
	waitReady()
	exchange()
	// Simulate a platform-invalidated listener while the owning node stays alive.
	initial.Close()
	waitReady()
	exchange()
	if binds.Load() != 2 {
		t.Fatalf("expected transient rebind failure then recovery: %d", binds.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("recovered bridge leaked on shutdown")
	}
	probe, err := net.ListenPacket("udp4", address)
	if err != nil {
		t.Fatal("shutdown left forwarding port bound:", err)
	}
	probe.Close()
}

func TestUDPRecoveryCancellationStopsRebind(t *testing.T) {
	initial, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	initial.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var binds atomic.Int32
	failed := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		RecoveringUDP(ctx, initial, func() (net.PacketConn, error) {
			binds.Add(1)
			return nil, errors.New("not ready")
		}, (&net.Dialer{}).DialContext, "127.0.0.1:1", allowAll, func(ready bool, err error) {
			if err != nil {
				select {
				case failed <- struct{}{}:
				default:
				}
			}
		})
	}()
	select {
	case <-failed:
	case <-time.After(time.Second):
		t.Fatal("listener failure not reported")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retry ignored cancellation")
	}
	if binds.Load() != 0 {
		t.Fatal("rebound after cancellation")
	}
}

func allowAll(net.Addr) bool { return true }

func TestTCPHalfCloseAndCancellation(t *testing.T) {
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		c, err := upstream.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		b, _ := io.ReadAll(c)
		c.Write(append([]byte("reply:"), b...))
	}()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- TCP(ctx, listener, (&net.Dialer{}).DialContext, upstream.Addr().String(), allowAll) }()
	c, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write([]byte("request"))
	c.(*net.TCPConn).CloseWrite()
	b, err := io.ReadAll(c)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "reply:request" {
		t.Fatalf("half-close lost response: %q", b)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("relay leaked after cancellation")
	}
}

func TestTCPUnauthorizedNeverDials(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var dials atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- TCP(ctx, listener, func(context.Context, string, string) (net.Conn, error) { dials.Add(1); return nil, io.EOF }, "unused", func(net.Addr) bool { return false })
	}()
	c, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	c.Write([]byte("private"))
	var b [1]byte
	c.Read(b[:])
	c.Close()
	cancel()
	<-done
	if dials.Load() != 0 {
		t.Fatal("unauthorized source reached upstream")
	}
}

func TestUDPBoundariesIndependentSendersAndCancellation(t *testing.T) {
	echo, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		b := make([]byte, 65535)
		for {
			n, addr, err := echo.ReadFrom(b)
			if err != nil {
				return
			}
			echo.WriteTo(b[:n], addr)
		}
	}()
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- UDP(ctx, listener, (&net.Dialer{}).DialContext, echo.LocalAddr().String(), allowAll) }()
	for client := range 3 {
		c, err := net.Dial("udp4", listener.LocalAddr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		for _, size := range []int{1, 16, 1024, 1184, 2048, 8, 0} {
			want := bytes.Repeat([]byte{byte(client + 1)}, size)
			if _, err = c.Write(want); err != nil {
				t.Fatal(err)
			}
			b := make([]byte, 65535)
			n, err := c.Read(b)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(want, b[:n]) {
				t.Fatalf("client %d datagram %d was altered, got %d bytes", client, size, n)
			}
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("active UDP sessions leaked after cancellation")
	}
}

func TestUDPRejectsUnauthorizedSource(t *testing.T) {
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var dials atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- UDP(ctx, listener, func(context.Context, string, string) (net.Conn, error) { dials.Add(1); return nil, io.EOF }, "unused", func(net.Addr) bool { return false })
	}()
	c, err := net.Dial("udp4", listener.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	c.Write([]byte("private"))
	b := make([]byte, 8)
	if _, err = c.Read(b); err == nil {
		t.Fatal("unexpected reply")
	}
	cancel()
	<-done
	if dials.Load() != 0 {
		t.Fatal("unauthorized UDP reached upstream")
	}
}
