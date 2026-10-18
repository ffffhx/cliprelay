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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Production desktop controllers and paired handlers communicate over mutual
// TLS. Audio/capture/mask workers are simulated, so this never mutes a device.
func TestAudioMuteDesktopControllerInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the desktop audio interop fixture")
	}
	client := fileTestCertificate(t)
	audio, _ := newAudioFixture(t)
	privacy, _ := newPrivacyFixture(t)
	var generation atomic.Uint64
	generation.Store(7)
	provider := func(context.Context, bool, *displaySelection) (displayState, error) {
		state := displayFixture(client.Certificate[0], []byte("other"))
		state.Streams = state.Streams[:1]
		state.Streams[0].Audio = &displayAudio{Capture: "process", Generation: generation.Load(), Ready: true}
		return state, nil
	}
	audio.control.provider, privacy.control.provider = provider, provider
	audio.control.now, privacy.control.now = time.Now, time.Now
	filePairing(t, audio.control.clients, client.Certificate[0])
	filePairing(t, privacy.control.clients, client.Certificate[0])
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	fixture := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/fixture/hold-recovery":
			audio.control.mu.Lock()
			audio.stopFails = true
			audio.control.mu.Unlock()
		case "/fixture/release-recovery":
			audio.control.mu.Lock()
			audio.stopFails = false
			audio.control.mu.Unlock()
		case "/fixture/new-audio":
			generation.Store(8)
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	server := httptest.NewUnstartedServer(audio.control.handler(privacy.control.handler(withDisplays(fixture, audio.control.clients, provider))))
	server.TLS = controlTLSConfig(host, audio.control.clients)
	server.StartTLS()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); audio.control.maintain(ctx) }()
	go func() { defer workers.Done(); privacy.control.maintain(ctx) }()
	defer func() { cancel(); workers.Wait() }()
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
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "desktop-audio-mute-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("desktop audio interop: %v %s", err, output)
	}
	var result struct{ Passed, Independent, GenerationRestored, RecoveryPending bool }
	if json.Unmarshal(output, &result) != nil || !result.Passed || !result.Independent || !result.GenerationRestored || !result.RecoveryPending {
		t.Fatalf("invalid fixture result: %s", output)
	}
	audio.control.mu.Lock()
	defer audio.control.mu.Unlock()
	privacy.control.mu.Lock()
	defer privacy.control.mu.Unlock()
	if audio.active != "" || audio.control.request.Lease != "" || audio.control.restoring || audio.starts != 3 || audio.stops < 3 || privacy.active != "" || privacy.starts != 1 || privacy.stops != 1 {
		t.Fatalf("unexpected restored lifecycle: audioStarts=%d audioStops=%d maskStarts=%d maskStops=%d", audio.starts, audio.stops, privacy.starts, privacy.stops)
	}
}
