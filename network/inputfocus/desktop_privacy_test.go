package inputfocus

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The desktop controller talks to production paired handlers over real mutual
// TLS. The display source and mask worker are fixtures; no physical mask opens.
func TestPrivacyDesktopControllerInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the desktop privacy interop fixture")
	}
	client := fileTestCertificate(t)
	f, _ := newPrivacyFixture(t)
	f.state = displayFixture(client.Certificate[0], []byte("other"))
	f.state.Streams = f.state.Streams[:1]
	f.control.now = time.Now
	filePairing(t, f.control.clients, client.Certificate[0])
	renews := 0
	read := f.control.read
	f.control.read = func(command string) (json.RawMessage, error) {
		var body privacyRequest
		if len(command) > len("privacy:") && json.Unmarshal([]byte(command[len("privacy:"):]), &body) == nil && body.Op == "renew" {
			renews++
		}
		return read(command)
	}
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(f.control.handler(withDisplays(http.NotFoundHandler(), f.control.clients, f.control.provider)))
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
		"host": map[string]any{"id": "fixture", "clientId": "desktop", "enabled": true, "address": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port - 2,
			"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: host.Certificate[0]}))},
		"identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))},
	})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "desktop-privacy-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("desktop privacy interop: %v %s", err, output)
	}
	var result struct{ Passed, RouteRestored bool }
	if json.Unmarshal(output, &result) != nil || !result.Passed || !result.RouteRestored {
		t.Fatalf("invalid fixture result: %s", output)
	}
	f.control.mu.Lock()
	defer f.control.mu.Unlock()
	if f.active != "" || f.control.request.Lease != "" || f.starts != 2 || f.stops != 2 || renews < 2 {
		t.Fatalf("privacy lifecycle: starts=%d stops=%d renews=%d maskActive=%t", f.starts, f.stops, renews, f.active != "")
	}
}
