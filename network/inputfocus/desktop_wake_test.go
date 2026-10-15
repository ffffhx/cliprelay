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

// The real wake handler uses a simulated inventory and send callback. This test
// verifies protocol interoperability and receipts without emitting UDP packets.
func TestWakeDesktopProtocolInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for desktop wake interoperability")
	}
	client := fileTestCertificate(t)
	f, _ := newWakeFixture(t)
	filePairing(t, f.control.clients, client.Certificate[0])
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(f.control.handler(http.NotFoundHandler()))
	server.TLS = controlTLSConfig(host, f.control.clients)
	server.StartTLS()
	defer server.Close()
	key, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{
		"host":     map[string]any{"address": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port - 2, "certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: host.Certificate[0]}))},
		"identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "desktop-wake-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("desktop wake interop: %v %s", err, output)
	}
	server.Close()
	var result struct{ Passed, Replayed bool }
	if json.Unmarshal(output, &result) != nil || !result.Passed || !result.Replayed || f.sends != 1 {
		t.Fatalf("invalid result: %s sends=%d", output, f.sends)
	}
}
