package inputfocus

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func filePairing(t *testing.T, path string, certificates ...[]byte) {
	t.Helper()
	devices := make([]any, 0, len(certificates))
	for _, cert := range certificates {
		devices = append(devices, map[string]any{"enabled": true, "cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}))})
	}
	data, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": devices}})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func fileCall(h http.Handler, certificate []byte, method, url, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if certificate != nil {
		r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: certificate}}}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestFileRequestsBindOwnershipAndRejectInvalidInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first paired phone"), []byte("second paired phone")
	filePairing(t, path, first, second)
	var owners []string
	provider := func(command string) (json.RawMessage, error) {
		if !strings.HasPrefix(command, "files:") {
			t.Fatal("wrong worker protocol")
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(command, "files:")), &payload); err != nil {
			t.Fatal(err)
		}
		owners = append(owners, payload["owner"].(string))
		return json.RawMessage(`{"ok":true,"roots":[{"id":"home","name":"home","writable":true}],"privateAbsolutePath":"secret"}`), nil
	}
	h := handler(path, provider, provider, provider)
	for _, peer := range [][]byte{nil, []byte("unpaired")} {
		if fileCall(h, peer, "POST", "/v1/files", `{"op":"roots"}`).Code != 403 {
			t.Fatal("unpaired file access")
		}
	}
	id := strings.Repeat("a", 32)
	invalid := []string{
		`{"op":"roots","owner":"` + strings.Repeat("b", 64) + `"}`,
		`{"op":"roots"}{"op":"roots"}`, `{"op":"execute"}`, `{"op":"status","id":"../x"}`,
		`{"op":"upload-start","id":"` + id + `","size":-1,"sha256":"` + strings.Repeat("c", 64) + `"}`,
		`{"op":"download-chunk","id":"` + id + `"}`, `{"op":"roots","data":"unexpected"}`,
		`{"op":"upload-chunk","id":"` + id + `","offset":0,"data":"AQ==","sha256":"wrong"}`,
		`{"op":"roots","path":"` + strings.Repeat("x", fileMessageLimit) + `"}`,
	}
	oversize := bytes.Repeat([]byte{1}, fileChunkSize+1)
	digest := sha256.Sum256(oversize)
	chunk, _ := json.Marshal(map[string]any{"op": "upload-chunk", "id": id, "offset": 0, "data": base64.StdEncoding.EncodeToString(oversize), "sha256": hex.EncodeToString(digest[:])})
	invalid = append(invalid, string(chunk))
	for _, body := range invalid {
		if w := fileCall(h, first, "POST", "/v1/files", body); w.Code != 400 {
			t.Fatalf("invalid request returned %d: %.100s", w.Code, body)
		}
	}
	if fileCall(h, first, "GET", "/v1/files", "").Code != 404 || fileCall(h, first, "POST", "/v1/files?owner=x", `{"op":"roots"}`).Code != 404 {
		t.Fatal("unexpected route")
	}
	if len(owners) != 0 {
		t.Fatal("invalid request reached filesystem worker")
	}
	for _, peer := range [][]byte{first, second} {
		w := fileCall(h, peer, "POST", "/v1/files", `{"op":"roots"}`)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "secret") {
			t.Fatal(w.Code, w.Body)
		}
		hash := sha256.Sum256(peer)
		if owners[len(owners)-1] != hex.EncodeToString(hash[:]) {
			t.Fatal("owner not derived from certificate")
		}
	}
	if owners[0] == owners[1] {
		t.Fatal("paired phones share file ownership")
	}
}

func TestFilesRevocationDuringWorkAndBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, path, cert)
	entered, release := make(chan struct{}), make(chan struct{})
	provider := func(string) (json.RawMessage, error) {
		close(entered)
		<-release
		return json.RawMessage(`{"ok":true}`), nil
	}
	h := handler(path, provider, provider, provider)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- fileCall(h, cert, "POST", "/v1/files", `{"op":"roots"}`) }()
	<-entered
	if w := fileCall(h, cert, "POST", "/v1/files", `{"op":"roots"}`); w.Code != 429 {
		t.Fatal("concurrent file work accepted", w.Code)
	}
	filePairing(t, path)
	close(release)
	if w := <-done; w.Code != 403 {
		t.Fatal("revoked in-flight response disclosed", w.Code)
	}
	if fileCall(h, cert, "POST", "/v1/files", `{"op":"roots"}`).Code != 403 {
		t.Fatal("revoked connection reused")
	}
}

func TestFilesProviderFailuresAreBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, path, cert)
	for _, reply := range []string{`{"ok":false,"code":"C:\\private\\path"}`, `{"ok":false,"code":"FILES_DISK_FULL","detail":"secret"}`, `invalid`, strings.Repeat("x", fileMessageLimit+1)} {
		provider := func(string) (json.RawMessage, error) { return json.RawMessage(reply), nil }
		w := fileCall(handler(path, provider, provider, provider), cert, "POST", "/v1/files", `{"op":"roots"}`)
		if w.Code == 200 || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "secret") || w.Body.Len() > 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	provider := func(string) (json.RawMessage, error) { return nil, errors.New("private provider failure") }
	if w := fileCall(handler(path, provider, provider, provider), cert, "POST", "/v1/files", `{"op":"roots"}`); w.Code != 503 || strings.Contains(w.Body.String(), "private") {
		t.Fatal(w.Code, w.Body)
	}
}

func fileTestCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestFilesMutualTLSAndReusedConnectionRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	pairedCert, otherCert := fileTestCertificate(t), fileTestCertificate(t)
	filePairing(t, path, pairedCert.Certificate[0])
	var reads atomic.Int32
	provider := func(string) (json.RawMessage, error) { reads.Add(1); return json.RawMessage(`{"ok":true}`), nil }
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(handler(path, provider, provider, provider))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = controlTLSConfig(host, path)
	server.StartTLS()
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	request := func(cert *tls.Certificate) *http.Client {
		config := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		if cert != nil {
			config.Certificates = []tls.Certificate{*cert}
		}
		transport := &http.Transport{TLSClientConfig: config}
		t.Cleanup(transport.CloseIdleConnections)
		return &http.Client{Transport: transport, Timeout: 3 * time.Second}
	}
	for _, cert := range []*tls.Certificate{nil, &otherCert} {
		response, err := request(cert).Post(server.URL+"/v1/files", "application/json", strings.NewReader(`{"op":"roots"}`))
		if err == nil {
			response.Body.Close()
			t.Fatal("unpaired TLS handshake succeeded")
		}
	}
	client := request(&pairedCert)
	response, err := client.Post(server.URL+"/v1/files", "application/json", strings.NewReader(`{"op":"roots"}`))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	filePairing(t, path)
	response, err = client.Post(server.URL+"/v1/files", "application/json", strings.NewReader(`{"op":"roots"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 || reads.Load() != 1 {
		t.Fatal("revoked TLS connection accessed files", response.StatusCode, reads.Load())
	}
}
