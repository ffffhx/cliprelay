package inputfocus

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestWakeDesktopControllerInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for desktop wake controller interoperability")
	}
	client := fileTestCertificate(t)
	target, _ := newWakeFixture(t)
	helper, _ := newWakeFixture(t)
	target.state.Adapters[0].MAC = wakeTestMAC
	target.state.Adapters[0].Addresses[0].Address = "192.168.0.3"
	filePairing(t, target.control.clients, client.Certificate[0])
	filePairing(t, helper.control.clients, client.Certificate[0])
	var online, loseReply atomic.Bool
	online.Store(true)
	loseReply.Store(true)
	drop := func(w http.ResponseWriter) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}
	targetHandler := target.control.handler(http.NotFoundHandler())
	helperHandler := helper.control.handler(http.NotFoundHandler())
	targetTLS := fileTestCertificate(t)
	helperTLS := fileTestCertificate(t)
	targetServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !online.Load() {
			drop(w)
			return
		}
		targetHandler.ServeHTTP(w, r)
	}))
	targetServer.TLS = controlTLSConfig(targetTLS, target.control.clients)
	targetServer.StartTLS()
	defer targetServer.Close()
	helperServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fixture-event" {
			var event struct {
				Online bool `json:"online"`
			}
			if json.NewDecoder(r.Body).Decode(&event) != nil {
				http.Error(w, "bad event", 400)
				return
			}
			online.Store(event.Online)
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1025))
		if err != nil {
			http.Error(w, "bad body", 400)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var request wakeRequest
		_ = json.Unmarshal(body, &request)
		reply := httptest.NewRecorder()
		helperHandler.ServeHTTP(reply, r)
		if request.Op == "send" && loseReply.Swap(false) {
			drop(w)
			return
		}
		for key, values := range reply.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(reply.Code)
		_, _ = w.Write(reply.Body.Bytes())
	}))
	helperServer.TLS = controlTLSConfig(helperTLS, helper.control.clients)
	helperServer.StartTLS()
	defer helperServer.Close()
	host := func(server *httptest.Server, certificate tls.Certificate, name string) map[string]any {
		return map[string]any{"address": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port - 2, "certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]})), "name": name}
	}
	key, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{"target": host(targetServer, targetTLS, "Target"), "helper": host(helperServer, helperTLS, "Helper"), "identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "windows", "tests", "desktop-wake-controller-fixture.cjs"))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("desktop wake controller interop: %v %s", err, output)
	}
	helperServer.Close()
	targetServer.Close()
	var result struct{ Passed, Replayed, Online bool }
	if json.Unmarshal(output, &result) != nil || !result.Passed || !result.Replayed || !result.Online || helper.sends != 1 || target.sends != 0 {
		t.Fatalf("invalid controller result: %s helper=%d target=%d", output, helper.sends, target.sends)
	}
}
