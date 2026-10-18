package inputfocus

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Production Go handlers and the desktop controller communicate over mutual
// TLS. Only display lifetime and the workstation worker are simulated.
func TestSessionLockDesktopControllerInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for desktop lock interoperability")
	}
	client := fileTestCertificate(t)
	f, _ := newLockFixture(t)
	f.state = displayFixture(client.Certificate[0], []byte("other"))
	f.state.Streams = f.state.Streams[:1]
	f.control.now = time.Now
	filePairing(t, f.control.clients, client.Certificate[0])
	pending := false
	read := f.control.read
	f.control.read = func(command string) (json.RawMessage, error) {
		var body privacyRequest
		if strings.HasPrefix(command, "session-lock:") && json.Unmarshal([]byte(command[13:]), &body) == nil && body.Op == "cancel" && pending {
			return nil, errors.New("simulated unavailable cancel acknowledgment")
		}
		return read(command)
	}
	displays := withDisplays(http.NotFoundHandler(), f.control.clients, f.control.provider)
	handler := f.control.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The standalone display handler and fixture events also own the mutex;
		// the production session-lock handler owns it internally.
		f.control.mu.Lock()
		defer f.control.mu.Unlock()
		if r.URL.Path != "/fixture-event" {
			displays.ServeHTTP(w, r)
			return
		}
		var event struct {
			Event string `json:"event"`
		}
		if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&event) != nil {
			http.Error(w, "bad fixture event", 400)
			return
		}
		switch event.Event {
		case "cancel-pending":
			pending = true
		case "cancel-ready":
			pending = false
		case "end":
			f.end()
		case "confirm":
			if f.result.State != "requested" {
				http.Error(w, "not requested", 409)
				return
			}
			f.result.State = "locked"
			f.result.ExpiresMs = 0
		default:
			http.Error(w, "unknown fixture event", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = controlTLSConfig(host, f.control.clients)
	server.StartTLS()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stopped := make(chan struct{})
	go func() { defer close(stopped); f.control.maintain(ctx) }()
	defer func() { cancel(); <-stopped }()
	key, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{
		"host":     map[string]any{"id": "fixture", "clientId": "desktop", "enabled": true, "address": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port - 2, "certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: host.Certificate[0]}))},
		"identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))},
	})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "desktop-session-lock-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("desktop session lock interop: %v %s", err, output)
	}
	var result struct{ Passed, CancelConfirmed, OneShot bool }
	if json.Unmarshal(output, &result) != nil || !result.Passed || !result.CancelConfirmed || !result.OneShot {
		t.Fatalf("invalid fixture output: %s", output)
	}
	f.control.mu.Lock()
	defer f.control.mu.Unlock()
	if f.arms != 2 || f.commits != 1 || f.cancels != 1 || f.result.State != "locked" {
		t.Fatalf("lock lifecycle arms=%d commits=%d cancels=%d state=%s", f.arms, f.commits, f.cancels, f.result.State)
	}
}
