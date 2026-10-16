package inputfocus

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
)

// Bind every required endpoint before launching native workers or advertising
// any part of the service. A partial bind is rolled back as one owned group.
type hostListeners struct {
	control, pairing, relay net.Listener
	discovery               *net.UDPConn
}

type hostListenConfig struct {
	control, pairing, discovery string
	relay                       func() (net.Listener, error)
}

func bindHostListeners(ctx context.Context, dir string) (*hostListeners, error) {
	return listenHost(ctx, hostListenConfig{
		control: ":48791", pairing: ":48792", discovery: ":47634",
		relay: func() (net.Listener, error) { return relayPipe(dir) },
	})
}

func listenHost(ctx context.Context, config hostListenConfig) (_ *hostListeners, err error) {
	listeners := &hostListeners{}
	defer func() {
		if err != nil {
			listeners.close()
		}
	}()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	var lc net.ListenConfig
	if listeners.control, err = lc.Listen(ctx, "tcp", config.control); err != nil {
		return nil, fmt.Errorf("control listener: %w", err)
	}
	if listeners.pairing, err = lc.Listen(ctx, "tcp", config.pairing); err != nil {
		return nil, fmt.Errorf("LAN pairing listener: %w", err)
	}
	var packet net.PacketConn
	if packet, err = lc.ListenPacket(ctx, "udp4", config.discovery); err != nil {
		return nil, fmt.Errorf("LAN discovery listener: %w", err)
	}
	listeners.discovery = packet.(*net.UDPConn)
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if listeners.relay, err = config.relay(); err != nil {
		return nil, fmt.Errorf("local relay listener: %w", err)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return listeners, nil
}

func (l *hostListeners) close() {
	for _, listener := range []net.Listener{l.control, l.pairing, l.relay} {
		if listener != nil {
			_ = listener.Close()
		}
	}
	if l.discovery != nil {
		_ = l.discovery.Close()
	}
}

// http.Server.Close closes sockets but does not join application handlers.
// Gate new handlers before Wait so an already accepted TLS connection cannot
// start application work after its owner's final teardown.
type ownedHTTP struct {
	server  *http.Server
	mu      sync.Mutex
	closed  bool
	pending sync.WaitGroup
}

func ownHTTP(ctx context.Context, server *http.Server) *ownedHTTP {
	owner := &ownedHTTP{server: server}
	handler := server.Handler
	server.BaseContext = func(net.Listener) context.Context { return ctx }
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		owner.mu.Lock()
		if owner.closed {
			owner.mu.Unlock()
			http.Error(w, "service stopping", http.StatusServiceUnavailable)
			return
		}
		owner.pending.Add(1)
		owner.mu.Unlock()
		defer owner.pending.Done()
		handler.ServeHTTP(w, r)
	})
	return owner
}

func (owner *ownedHTTP) stop() {
	owner.mu.Lock()
	owner.closed = true
	owner.mu.Unlock()
	_ = owner.server.Close()
}

// ctx/cancel are the same service context used by native workers and managers.
// Any required listener's unexpected exit cancels the whole group. Returning
// means all serving loops, active application handlers and pair requests joined.
func runHostListeners(ctx context.Context, cancel context.CancelFunc, listeners *hostListeners,
	control *http.Server, pairer *lanPairer, certificate tls.Certificate, relay *relayMailbox) error {
	controlOwner := ownHTTP(ctx, control)
	pairingOwner := ownHTTP(ctx, lanPairingServer(certificate, pairer))
	type result struct {
		name string
		err  error
	}
	results := make(chan result, 4)
	start := func(name string, serve func() error) {
		go func() { results <- result{name, serve()} }()
	}
	start("control listener", func() error { return control.ServeTLS(listeners.control, "", "") })
	start("LAN pairing listener", func() error { return pairingOwner.server.ServeTLS(listeners.pairing, "", "") })
	start("LAN discovery listener", func() error { return serveLANDiscovery(listeners.discovery) })
	start("local relay listener", func() error { return relay.serveLocal(ctx, listeners.relay) })
	maintenanceDone := make(chan struct{})
	go func() { defer close(maintenanceDone); relay.maintain(ctx) }()
	remaining := 4
	var err error
	select {
	case <-ctx.Done():
		err = ctx.Err()
	case stopped := <-results:
		remaining--
		err = ctx.Err()
		if err == nil {
			if stopped.err == nil {
				stopped.err = errors.New("stopped unexpectedly")
			}
			err = fmt.Errorf("%s: %w", stopped.name, stopped.err)
		}
	}
	cancel()
	controlOwner.stop()
	pairingOwner.stop()
	listeners.close()
	for ; remaining > 0; remaining-- {
		<-results
	}
	<-maintenanceDone
	controlOwner.pending.Wait()
	pairingOwner.pending.Wait()
	pairer.close()
	return err
}
