package inputfocus

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"image"
	"image/jpeg"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMacClientRealRelayAndDesktopWorker(t *testing.T) {
	workerPath := os.Getenv("CLIPRELAY_CLIPBOARD_TEST_WORKER")
	if workerPath == "" {
		t.Skip("set CLIPRELAY_CLIPBOARD_TEST_WORKER to the fake-clipboard C# worker")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the Mac protocol interop fixture")
	}
	worker := &probe{executable: workerPath, argument: "--clipboard-probe", maxOutput: clipboardMessageLimit, timeout: 10 * time.Second}
	defer worker.stop()
	clients := filepath.Join(t.TempDir(), "clients.json")
	client := fileTestCertificate(t)
	filePairing(t, clients, client.Certificate[0])
	mailbox := newRelayMailbox(clients)
	owner := displayOwner(client.Certificate[0])
	mailbox.remote(owner, relayCommand{Op: "poll"})
	ids := []string{strings.Repeat("1", 32), strings.Repeat("2", 32)}
	body := []byte(`{"text":"Go to Mac 中文 👋"}`)
	relayPublish(t, mailbox.local, owner, ids[0], "json", body)
	var imageBytes bytes.Buffer
	if err := jpeg.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 32, 24)), nil); err != nil {
		t.Fatal(err)
	}
	imageHash := relayPublish(t, mailbox.local, owner, ids[1], "jpeg", imageBytes.Bytes())
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(mailbox.handler(withClipboard(http.NotFoundHandler(), clients, worker.read)))
	server.TLS = controlTLSConfig(host, clients)
	server.StartTLS()
	defer server.Close()
	key, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 32, 24))); err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{
		"host":     map[string]any{"address": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port - 2, "certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: host.Certificate[0]}))},
		"identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))},
		"png":      base64.StdEncoding.EncodeToString(pngBytes.Bytes()),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "mac-client-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Mac client interop: %v %s", err, output)
	}
	var result struct {
		Received                    []struct{ Kind, Text, SHA256 string }
		ClipboardText, ClipboardPng bool
	}
	if json.Unmarshal(output, &result) != nil || !result.ClipboardText || !result.ClipboardPng || len(result.Received) != 2 || result.Received[0].Text != "Go to Mac 中文 👋" || result.Received[1].Kind != "jpeg" || result.Received[1].SHA256 != imageHash {
		t.Fatalf("Invalid fixture result: %s", output)
	}
	for _, id := range ids {
		if value := mailbox.local(relayCommand{Op: "status", Owner: owner, ID: id}); value.State != "delivered" {
			t.Fatal("Mac did not confirm delivery", value)
		}
	}
	if mailbox.allocated != 0 {
		t.Fatal("Mac acknowledgement retained payload bytes")
	}
}
