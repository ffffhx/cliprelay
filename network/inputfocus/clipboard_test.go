package inputfocus

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClipboardAuthenticationBoundsAndFilteredReplies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired phone")
	filePairing(t, path, cert)
	calls := 0
	h := withClipboard(http.NotFoundHandler(), path, func(command string) (json.RawMessage, error) {
		calls++
		var request map[string]string
		if !strings.HasPrefix(command, "clipboard:") || json.Unmarshal([]byte(command[10:]), &request) != nil || request["owner"] != displayOwner(cert) {
			t.Fatal("worker identity was not host-derived")
		}
		return json.RawMessage(`{"ok":true,"kind":"text","text":"中文 👋\nclipboard","private":"secret"}`), nil
	})
	for _, peer := range [][]byte{nil, []byte("unpaired")} {
		if fileCall(h, peer, "POST", "/v1/clipboard", `{"op":"read"}`).Code != 403 {
			t.Fatal("unauthorized clipboard access")
		}
	}
	for _, body := range []string{`{"op":"read","owner":"forged"}`, `{"op":"execute"}`, `{"op":"read","text":"unexpected"}`, `{"op":"write","id":"bad","kind":"text","text":"x"}`, `{"op":"read"}{}`, `{"op":"write","id":"` + strings.Repeat("1", 32) + `","kind":"text","text":"bad\u0000text"}`} {
		if result := fileCall(h, cert, "POST", "/v1/clipboard", body); result.Code != 400 {
			t.Fatal(result.Code, body)
		}
	}
	if calls != 0 {
		t.Fatal("invalid input reached clipboard")
	}
	response := fileCall(h, cert, "POST", "/v1/clipboard", `{"op":"read"}`)
	if response.Code != 200 || strings.Contains(response.Body.String(), "secret") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(response.Code, response.Body)
	}
	response = fileCall(h, cert, "POST", "/v1/clipboard", `{"op":"write","id":"`+strings.Repeat("1", 32)+`","kind":"text","text":"hello"}`)
	if response.Code != 200 || strings.Contains(response.Body.String(), "clipboard") {
		t.Fatal("write reply exposed provider data", response.Body)
	}
	oversized := strings.Repeat(" ", clipboardMessageLimit+1)
	if fileCall(h, cert, "POST", "/v1/clipboard", oversized).Code != 413 {
		t.Fatal("unbounded body")
	}
	if validClipboard("text", strings.Repeat("中", clipboardTextLimit/3+1), "") || validClipboard("png", "", "bmFk") {
		t.Fatal("payload validation")
	}
	if fileCall(h, cert, "GET", "/v1/clipboard", "").Code != 404 || fileCall(h, cert, "POST", "/v1/clipboard?x=1", `{"op":"read"}`).Code != 404 {
		t.Fatal("unexpected route")
	}
}

func TestClipboardRevocationDuringRequestAndBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, path, cert)
	entered, release := make(chan struct{}), make(chan struct{})
	h := withClipboard(http.NotFoundHandler(), path, func(string) (json.RawMessage, error) {
		close(entered)
		<-release
		return json.RawMessage(`{"ok":true,"kind":"text","text":"private"}`), nil
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- fileCall(h, cert, "POST", "/v1/clipboard", `{"op":"read"}`) }()
	<-entered
	if fileCall(h, cert, "POST", "/v1/clipboard", `{"op":"read"}`).Code != 429 {
		t.Error("overlapping request entered worker")
	}
	filePairing(t, path)
	close(release)
	response := <-done
	if response.Code != 403 || strings.Contains(response.Body.String(), "private") {
		t.Fatal("revoked in-flight response leaked")
	}
	filePairing(t, path, cert)
	calls := 0
	h = withClipboard(http.NotFoundHandler(), path, func(string) (json.RawMessage, error) { calls++; return nil, nil })
	r := httptest.NewRequest("POST", "/v1/clipboard", &clipboardRevokingReader{Reader: strings.NewReader(`{"op":"read"}`), revoke: func() { filePairing(t, path) }})
	r.Header.Set("Content-Type", "application/json")
	r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
	response = httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 403 || calls != 0 {
		t.Fatal("body-time revocation ignored")
	}
}

type clipboardRevokingReader struct {
	*strings.Reader
	revoke func()
}

func (r *clipboardRevokingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF {
		r.revoke()
	}
	return n, err
}

func TestClipboardMutualTLSAndConnectionRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	phone, other := fileTestCertificate(t), fileTestCertificate(t)
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	filePairing(t, path, phone.Certificate[0])
	h := withClipboard(http.NotFoundHandler(), path, func(string) (json.RawMessage, error) {
		return json.RawMessage(`{"ok":true,"kind":"text","text":"fixture"}`), nil
	})
	server := httptest.NewUnstartedServer(h)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = controlTLSConfig(host, path)
	server.StartTLS()
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	makeClient := func(cert *tls.Certificate) *http.Client {
		config := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}
		if cert != nil {
			config.Certificates = []tls.Certificate{*cert}
		}
		transport := &http.Transport{TLSClientConfig: config}
		t.Cleanup(transport.CloseIdleConnections)
		return &http.Client{Transport: transport, Timeout: 3 * time.Second}
	}
	for _, cert := range []*tls.Certificate{nil, &other} {
		response, err := makeClient(cert).Post(server.URL+"/v1/clipboard", "application/json", strings.NewReader(`{"op":"read"}`))
		if err == nil {
			response.Body.Close()
			t.Fatal("unpaired TLS accepted")
		}
	}
	client := makeClient(&phone)
	response, err := client.Post(server.URL+"/v1/clipboard", "application/json", strings.NewReader(`{"op":"read"}`))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	filePairing(t, path)
	response, err = client.Post(server.URL+"/v1/clipboard", "application/json", strings.NewReader(`{"op":"read"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("reused TLS bypassed revocation")
	}
}

func TestClipboardRealDesktopWorkerProtocol(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_CLIPBOARD_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_CLIPBOARD_TEST_WORKER to the fake-clipboard C# test worker")
	}
	worker := &probe{executable: executable, argument: "--clipboard-probe", maxOutput: clipboardMessageLimit, timeout: 10 * time.Second}
	defer worker.stop()
	path := filepath.Join(t.TempDir(), "clients.json")
	phone := fileTestCertificate(t)
	filePairing(t, path, phone.Certificate[0])
	h := withClipboard(http.NotFoundHandler(), path, worker.read)
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(h)
	server.TLS = controlTLSConfig(host, path)
	server.StartTLS()
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, Certificates: []tls.Certificate{phone}}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	request := func(value any) clipboardResponse {
		body, _ := json.Marshal(value)
		response, err := client.Post(server.URL+"/v1/clipboard", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 {
			t.Fatal(response.StatusCode, string(data), err)
		}
		var result clipboardResponse
		if json.Unmarshal(data, &result) != nil || !result.OK {
			t.Fatal(string(data))
		}
		return result
	}
	text := "中文 👩‍💻\nquoted \" < & >"
	request(clipboardRequest{Op: "write", ID: strings.Repeat("1", 32), Kind: "text", Text: text})
	if request(clipboardRequest{Op: "read"}).Text != text {
		t.Fatal("cross-language text changed")
	}
	var pngBytes bytes.Buffer
	png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 32, 24)))
	data := base64.StdEncoding.EncodeToString(pngBytes.Bytes())
	request(clipboardRequest{Op: "write", ID: strings.Repeat("2", 32), Kind: "png", Data: data})
	if request(clipboardRequest{Op: "read"}).Data != data {
		t.Fatal("cross-language image changed")
	}
	request(clipboardRequest{Op: "write", ID: strings.Repeat("1", 32), Kind: "text", Text: text})
	if request(clipboardRequest{Op: "read"}).Kind != "png" {
		t.Fatal("late duplicate overwrote newer clipboard")
	}
}

func TestClipboardProviderFailuresCannotExposePrivateFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, path, cert)
	for _, result := range []string{
		`{"ok":true,"kind":"text","text":123}`,
		`{"ok":true,"kind":"html","text":"private"}`,
		`{"ok":false,"code":"C:/private/folder","text":"private"}`,
		`{"ok":true,"kind":"png","data":"bad!","privatePath":"private"}`,
		strings.Repeat(" ", clipboardMessageLimit+1),
	} {
		h := withClipboard(http.NotFoundHandler(), path, func(string) (json.RawMessage, error) { return json.RawMessage(result), nil })
		response := fileCall(h, cert, "POST", "/v1/clipboard", `{"op":"read"}`)
		if response.Code != 503 || strings.Contains(response.Body.String(), "private") {
			t.Fatal("invalid worker output exposed", response.Code, response.Body)
		}
	}
}
