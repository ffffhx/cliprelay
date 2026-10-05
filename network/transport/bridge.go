// Package transport adapts ClipRelay's existing socket-based engines to an
// application-owned network. UDP datagrams remain datagrams in both directions.
package transport

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

type DialFunc func(context.Context, string, string) (net.Conn, error)
type AllowFunc func(net.Addr) bool

// RecoveringUDP keeps a bound forwarding port alive until cancellation. A
// failed ReadFrom must not silently remove a port for the lifetime of the app.
// The old listener and its sessions are closed before binding its replacement.
// state is called serially and contains only listener errors, never payloads.
func RecoveringUDP(ctx context.Context, initial net.PacketConn, listen func() (net.PacketConn, error), dial DialFunc, target string, allow AllowFunc, state func(bool, error)) {
	if state == nil {
		state = func(bool, error) {}
	}
	listener := initial
	defer state(false, nil)
	for {
		state(true, nil)
		err := UDP(ctx, listener, dial, target, allow)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			err = errors.New("UDP listener stopped")
		}
		state(false, err)
		delay := 250 * time.Millisecond
		for {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			listener, err = listen()
			if err == nil {
				break
			}
			state(false, err)
			if delay < 2*time.Second {
				delay *= 2
			}
		}
	}
}

// TCP serves an already bound listener until ctx is cancelled. allow is required
// so a caller cannot accidentally expose a local service to the whole tailnet.
func TCP(ctx context.Context, listener net.Listener, dial DialFunc, target string, allow AllowFunc) error {
	if allow == nil {
		return errors.New("missing peer authorization")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	defer listener.Close()
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	// A socket relay must not create an unbounded number of upstream connections.
	slots := make(chan struct{}, 32)
	for {
		incoming, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !allow(incoming.RemoteAddr()) {
			incoming.Close()
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			incoming.Close()
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			defer incoming.Close()
			dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			outgoing, err := dial(dialCtx, "tcp", target)
			cancel()
			if err != nil {
				return
			}
			defer outgoing.Close()
			closeOnCancel := context.AfterFunc(ctx, func() { incoming.Close(); outgoing.Close() })
			defer closeOnCancel()
			closed := make(chan struct{})
			go func() {
				io.Copy(outgoing, incoming)
				if half, ok := outgoing.(interface{ CloseWrite() error }); ok {
					half.CloseWrite()
				} else {
					outgoing.Close()
				}
				close(closed)
			}()
			io.Copy(incoming, outgoing)
			incoming.Close()
			outgoing.Close()
			<-closed
		}()
	}
}

// UDP forwards each sender through a separate connected UDP socket, preserving
// replies and packet boundaries. It bounds both concurrent senders and idle time.
// Cancellation closes the listener, pending dials and all active sessions.
func UDP(ctx context.Context, listener net.PacketConn, dial DialFunc, target string, allow AllowFunc) error {
	if allow == nil {
		return errors.New("missing peer authorization")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	defer listener.Close()
	type session struct{ packets chan []byte }
	var mu sync.Mutex
	sessions := make(map[string]*session)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	buffer := make([]byte, 65535)
	for {
		n, source, err := listener.ReadFrom(buffer)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !allow(source) {
			continue
		}
		key := source.String()
		mu.Lock()
		s := sessions[key]
		if s == nil && len(sessions) < 16 {
			s = &session{packets: make(chan []byte, 64)}
			sessions[key] = s
			workers.Add(1)
			go func(s *session) {
				defer workers.Done()
				defer func() { mu.Lock(); delete(sessions, key); mu.Unlock() }()
				dialCtx, cancelDial := context.WithTimeout(ctx, 10*time.Second)
				upstream, err := dial(dialCtx, "udp", target)
				cancelDial()
				if err != nil {
					return
				}
				defer upstream.Close()
				closeOnCancel := context.AfterFunc(ctx, func() { upstream.Close() })
				defer closeOnCancel()
				done := make(chan struct{})
				go func() {
					defer close(done)
					buf := make([]byte, 65535)
					for {
						upstream.SetReadDeadline(time.Now().Add(60 * time.Second))
						n, err := upstream.Read(buf)
						if err != nil {
							return
						}
						if _, err = listener.WriteTo(buf[:n], source); err != nil {
							return
						}
					}
				}()
				defer func() { upstream.Close(); <-done }()
				for {
					select {
					case packet := <-s.packets:
						upstream.SetWriteDeadline(time.Now().Add(5 * time.Second))
						if _, err := upstream.Write(packet); err != nil {
							return
						}
					case <-done:
						return
					case <-ctx.Done():
						return
					}
				}
			}(s)
		}
		mu.Unlock()
		if s != nil {
			packet := append([]byte(nil), buffer[:n]...)
			select {
			case s.packets <- packet:
			default: /* UDP congestion: drop, do not block other senders. */
			}
		}
	}
}
