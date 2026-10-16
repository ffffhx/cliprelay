package inputfocus

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hostLoopbackConfig() hostListenConfig {
	return hostListenConfig{
		control: "127.0.0.1:0", pairing: "127.0.0.1:0", discovery: "127.0.0.1:0",
		// Production IPC still uses its OS-protected socket/pipe. Only this
		// disposable test fixture substitutes a loopback TCP listener.
		relay: func() (net.Listener, error) { return net.Listen("tcp4", "127.0.0.1:0") },
	}
}

func TestHostListenersBindingRollback(t *testing.T) {
	for _, failed := range []string{"control", "pairing", "discovery", "relay"} {
		t.Run(failed, func(t *testing.T) {
			reserved, err := listenHost(context.Background(), hostLoopbackConfig())
			if err != nil {
				t.Fatal(err)
			}
			defer reserved.close()
			config := hostListenConfig{control: reserved.control.Addr().String(), pairing: reserved.pairing.Addr().String(), discovery: reserved.discovery.LocalAddr().String()}
			var relayCalled bool
			config.relay = func() (net.Listener, error) {
				relayCalled = true
				return nil, errors.New("fixture IPC bind failure")
			}
			if failed != "control" {
				_ = reserved.control.Close()
			}
			if failed != "pairing" {
				_ = reserved.pairing.Close()
			}
			if failed != "discovery" {
				_ = reserved.discovery.Close()
			}
			got, err := listenHost(context.Background(), config)
			if got != nil || err == nil || !strings.Contains(err.Error(), failed) {
				if got != nil {
					got.close()
				}
				t.Fatalf("partial listener group admitted (%s): %v", failed, err)
			}
			if relayCalled != (failed == "relay") {
				t.Fatal("binding continued after failure")
			}
			// Closing the deliberate conflict must leave every endpoint reusable;
			// otherwise a previous successful bind leaked during rollback.
			reserved.close()
			assertHostPortsFree(t, reserved)
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	config := hostLoopbackConfig()
	config.relay = func() (net.Listener, error) {
		t.Error("cancelled bind reached IPC")
		return nil, errors.New("unexpected bind")
	}
	if got, err := listenHost(ctx, config); got != nil || !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled owner opened listeners", err)
	}
}

func hostServerFixture(t *testing.T) (string, tls.Certificate, EngineAccess) {
	t.Helper()
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	cert := seed.TLS.Certificates[0]
	seed.Close()
	directory := t.TempDir()
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, block := range map[string]*pem.Block{
		"cacert.pem": {Type: "CERTIFICATE", Bytes: cert.Certificate[0]},
		"cakey.pem":  {Type: "PRIVATE KEY", Bytes: key},
	} {
		if err := os.WriteFile(filepath.Join(directory, name), pem.EncodeToMemory(block), 0600); err != nil {
			t.Fatal(err)
		}
	}
	filePairing(t, filepath.Join(directory, "clients.json"), cert.Certificate[0])
	access, err := NewMemoryEngineAccess(strings.Repeat("fixture-password", 2), cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(access.Close)
	return directory, cert, access.Read
}

func hostFixtureClient(t *testing.T, cert tls.Certificate) *http.Client {
	t.Helper()
	roots := x509.NewCertPool()
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	roots.AddCert(parsed)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 4 * time.Second}
}

func TestHostListenersFullServiceLifecycle(t *testing.T) {
	executable := buildProbeOwnerFixture(t)
	for _, stopped := range []string{"cancel", "control", "pairing", "discovery", "relay"} {
		t.Run(stopped, func(t *testing.T) {
			directory, cert, access := hostServerFixture(t)
			started, exited := filepath.Join(directory, "worker-started"), filepath.Join(directory, "worker-exited")
			t.Setenv("CLIPRELAY_PROBE_FIXTURE_STARTED", started)
			t.Setenv("CLIPRELAY_PROBE_FIXTURE_EXITED", exited)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			bound := make(chan *hostListeners, 1)
			done := make(chan error, 1)
			finished := make(chan struct{})
			t.Cleanup(func() {
				cancel()
				select {
				case <-finished:
				case <-time.After(20 * time.Second):
					t.Error("fixture service failed to finish cleanup")
				}
			})
			go func() {
				defer close(finished)
				done <- serveWithEngineAccess(ctx, directory, executable, access, func(ctx context.Context, _ string) (*hostListeners, error) {
					listeners, err := listenHost(ctx, hostLoopbackConfig())
					if err == nil {
						bound <- listeners
					}
					return listeners, err
				})
			}()
			var listeners *hostListeners
			select {
			case listeners = <-bound:
			case err := <-done:
				t.Fatal("service exited before binding", err)
			case <-time.After(5 * time.Second):
				t.Fatal("service did not bind")
			}
			defer listeners.close()
			client := hostFixtureClient(t, cert)
			response, err := client.Get("https://" + listeners.control.Addr().String() + "/not-a-control-command")
			if err != nil {
				t.Fatal("control TLS listener never became ready", err)
			}
			response.Body.Close()
			if response.StatusCode != 404 {
				t.Fatal("paired control request rejected", response.StatusCode)
			}
			response, err = client.Post("https://"+listeners.pairing.Addr().String()+"/v1/pair", "application/json",
				strings.NewReader(`{"name":"disposable fixture","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`))
			if err != nil {
				t.Fatal("pairing TLS listener never became ready", err)
			}
			var pending lanRequest
			err = json.NewDecoder(response.Body).Decode(&pending)
			response.Body.Close()
			if err != nil || response.StatusCode != 200 || !pairNonce.MatchString(pending.ID) {
				t.Fatal("pending pairing not created", err)
			}
			requestPath := filepath.Join(directory, "lan-pairing", pending.ID+".json")
			if _, err := os.Stat(requestPath); err != nil {
				t.Fatal(err)
			}
			// A partial local frame must not survive until its five-second I/O
			// deadline after the service's owner has already returned.
			connection, err := net.DialTimeout("tcp", listeners.relay.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			if _, err := io.WriteString(connection, `{"op":`); err != nil {
				t.Fatal(err)
			}
			pid, err := os.ReadFile(started)
			if err != nil || len(pid) == 0 {
				t.Fatal("native fixture was not started", err)
			}
			switch stopped {
			case "cancel":
				cancel()
			case "control":
				_ = listeners.control.Close()
			case "pairing":
				_ = listeners.pairing.Close()
			case "discovery":
				_ = listeners.discovery.Close()
			case "relay":
				_ = listeners.relay.Close()
			}
			select {
			case err = <-done:
				if stopped == "cancel" && !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation lost", err)
				}
				if stopped != "cancel" && (err == nil || !strings.Contains(err.Error(), stopped)) {
					t.Fatal("failed endpoint was hidden", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("service returned without promptly joining cancelled listeners")
			}
			if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
				t.Fatal("pending pairing survived service exit", err)
			}
			if got, err := os.ReadFile(exited); err != nil || string(got) != string(pid) {
				t.Fatal("service returned before native worker EOF exit", err)
			}
			_ = connection.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := connection.Read(make([]byte, 1)); err == nil {
				t.Fatal("half-read IPC connection remained open")
			} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				t.Fatal("half-read IPC survived shutdown")
			}
			assertHostPortsFree(t, listeners)
		})
	}
	t.Run("bind failure launches no native worker", func(t *testing.T) {
		directory, _, access := hostServerFixture(t)
		marker := filepath.Join(directory, "must-not-start")
		t.Setenv("CLIPRELAY_PROBE_FIXTURE_STARTED", marker)
		failure := errors.New("fixture required listener unavailable")
		err := serveWithEngineAccess(context.Background(), directory, executable, access, func(context.Context, string) (*hostListeners, error) { return nil, failure })
		if !errors.Is(err, failure) {
			t.Fatal("bind failure lost", err)
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("native worker launched before listeners were admitted")
		}
	})
}

func TestHostListenersJoinActiveHTTPHandlers(t *testing.T) {
	directory, cert, access := hostServerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listeners, err := listenHost(ctx, hostLoopbackConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer listeners.close()
	entered, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	var calls atomic.Int32
	control := &http.Server{TLSConfig: controlTLSConfig(cert, filepath.Join(directory, "clients.json")), Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) != 1 {
			t.Error("late handler admitted")
			return
		}
		close(entered)
		<-r.Context().Done()
		close(cancelled)
		<-release
	})}
	serverDone := make(chan error, 1)
	finished := make(chan struct{})
	t.Cleanup(func() { cancel(); waitHostSignal(t, finished, "fixture server cleanup") })
	go func() {
		defer close(finished)
		serverDone <- runHostListeners(ctx, cancel, listeners, control, newLANPairerWithAccess(ctx, directory, cert, access), cert, newRelayMailbox(filepath.Join(directory, "clients.json")))
	}()
	client := hostFixtureClient(t, cert)
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		if response, err := client.Get("https://" + listeners.control.Addr().String()); err == nil {
			response.Body.Close()
		}
	}()
	waitHostSignal(t, entered, "active handler")
	cancel()
	waitHostSignal(t, cancelled, "handler context cancellation")
	waitHostSignal(t, clientDone, "HTTP socket closure")
	// The first handler is deliberately held after observing cancellation.
	// Closing the sockets alone must not allow the listener owner to return.
	select {
	case err := <-serverDone:
		t.Fatal("owner returned with active handler", err)
	default:
	}
	w := httptest.NewRecorder()
	control.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 || calls.Load() != 1 {
		t.Fatal("closed HTTP owner admitted late work")
	}
	close(release)
	select {
	case err := <-serverDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("handler owner did not join")
	}
	assertHostPortsFree(t, listeners)
}

func waitHostSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for " + name)
	}
}

func assertHostPortsFree(t *testing.T, listeners *hostListeners) {
	t.Helper()
	for _, previous := range []net.Listener{listeners.control, listeners.pairing, listeners.relay} {
		fresh, err := net.Listen("tcp", previous.Addr().String())
		if err != nil {
			t.Fatal("TCP endpoint survived teardown", err)
		}
		fresh.Close()
	}
	fresh, err := net.ListenPacket("udp4", listeners.discovery.LocalAddr().String())
	if err != nil {
		t.Fatal("discovery endpoint survived teardown", err)
	}
	fresh.Close()
}

type observedRelayListener struct {
	net.Listener
	reading, ended chan struct{}
}

type observedRelayConnection struct {
	net.Conn
	reading, ended    chan struct{}
	started, finished sync.Once
}

func (l *observedRelayListener) Accept() (net.Conn, error) {
	connection, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &observedRelayConnection{Conn: connection, reading: l.reading, ended: l.ended}, nil
}

func (c *observedRelayConnection) Read(buffer []byte) (int, error) {
	c.started.Do(func() { close(c.reading) })
	n, err := c.Conn.Read(buffer)
	if err != nil {
		c.finished.Do(func() { close(c.ended) })
	}
	return n, err
}

func TestHostListenersLocalRelayJoinsIncompleteFrame(t *testing.T) {
	mailbox, _, _ := relayFixture(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	observed := &observedRelayListener{Listener: listener, reading: make(chan struct{}), ended: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = mailbox.serveLocal(ctx, observed) }()
	t.Cleanup(func() { cancel(); waitHostSignal(t, done, "local relay cleanup") })
	connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, `{"op":`); err != nil {
		t.Fatal(err)
	}
	waitHostSignal(t, observed.reading, "accepted local frame read")
	cancel()
	waitHostSignal(t, done, "local relay stop")
	select {
	case <-observed.ended:
	default:
		t.Fatal("owner returned while accepted connection was still reading")
	}
}
