package inputfocus

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log"
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

func relayFixture(t *testing.T) (*relayMailbox, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, path, []byte("first"), []byte("second"))
	m := newRelayMailbox(path)
	first, second := displayOwner([]byte("first")), displayOwner([]byte("second"))
	m.remote(first, relayCommand{Op: "poll"})
	m.remote(second, relayCommand{Op: "poll"})
	return m, first, second
}

func relayPublish(t *testing.T, send func(relayCommand) relayReply, owner, id, kind string, body []byte) string {
	t.Helper()
	hash := displayOwner(body)
	if result := send(relayCommand{Op: "begin", Owner: owner, ID: id, Kind: kind, Size: len(body), SHA256: hash}); !result.OK || result.State != "uploading" {
		t.Fatal(result)
	}
	for offset := 0; offset < len(body); offset += relayChunk {
		data := base64.StdEncoding.EncodeToString(body[offset:min(offset+relayChunk, len(body))])
		command := relayCommand{Op: "chunk", Owner: owner, ID: id, Offset: offset, Data: data}
		if result := send(command); !result.OK {
			t.Fatal(result)
		}
		// A dropped local response may cause the identical upload chunk to repeat.
		if result := send(command); !result.OK {
			t.Fatal(result)
		}
	}
	if result := send(relayCommand{Op: "commit", Owner: owner, ID: id}); !result.OK || result.State != "queued" {
		t.Fatal(result)
	}
	return hash
}

func TestRelayReceiptAndRecipientIsolation(t *testing.T) {
	m, first, second := relayFixture(t)
	id := strings.Repeat("1", 32)
	body := []byte(`{"text":"中文 👩‍💻\nclipboard"}`)
	hash := relayPublish(t, m.local, first, id, "json", body)
	if got := m.remote(second, relayCommand{Op: "poll"}); got.State != "idle" {
		t.Fatal("other device saw message", got)
	}
	if got := m.remote(second, relayCommand{Op: "read", ID: id}); got.OK {
		t.Fatal("other device read message")
	}
	if got := m.remote(second, relayCommand{Op: "ack", ID: id, SHA256: hash}); got.OK {
		t.Fatal("other device acknowledged message")
	}
	if got := m.remote(first, relayCommand{Op: "poll"}); !got.OK || got.ID != id || got.SHA256 != hash || got.Size != len(body) {
		t.Fatal(got)
	}
	if got := m.remote(first, relayCommand{Op: "read", ID: id}); got.Data != base64.StdEncoding.EncodeToString(body) {
		t.Fatal(got)
	}
	if got := m.local(relayCommand{Op: "status", Owner: first, ID: id}); got.State != "queued" {
		t.Fatal("download was falsely treated as delivery", got)
	}
	if got := m.remote(first, relayCommand{Op: "ack", ID: id, SHA256: strings.Repeat("a", 64)}); got.OK {
		t.Fatal("wrong digest ack accepted")
	}
	for i := 0; i < 2; i++ {
		if got := m.remote(first, relayCommand{Op: "ack", ID: id, SHA256: hash}); !got.OK || got.State != "delivered" {
			t.Fatal(got)
		}
	}
	if got := m.local(relayCommand{Op: "status", Owner: first, ID: id}); got.State != "delivered" || m.allocated != 0 {
		t.Fatal(got, m.allocated)
	}
	if got := m.local(relayCommand{Op: "begin", Owner: first, ID: id, Kind: "json", Size: len(body), SHA256: hash}); got.State != "delivered" {
		t.Fatal("duplicate requeued content", got)
	}
	if got := m.remote(first, relayCommand{Op: "read", ID: id}); got.OK || got.Data != "" {
		t.Fatal("content retained after ack")
	}
}

func TestRelayBoundsExpiryCancellationAndRevocation(t *testing.T) {
	m, first, _ := relayFixture(t)
	now := time.Now()
	m.now = func() time.Time { return now }
	begin := relayCommand{Op: "begin", Owner: first, ID: strings.Repeat("2", 32), Kind: "jpeg", Size: relayLimit, SHA256: strings.Repeat("a", 64)}
	for i := 0; i < 2; i++ {
		begin.ID = fmt.Sprintf("%032x", i)
		if !m.local(begin).OK {
			t.Fatal("allocation")
		}
	}
	begin.ID = strings.Repeat("f", 32)
	if got := m.local(begin); got.Code != "RELAY_BUSY" {
		t.Fatal("memory limit ignored", got)
	}
	now = now.Add(31 * time.Second)
	if got := m.local(relayCommand{Op: "status", Owner: first, ID: fmt.Sprintf("%032x", 0)}); got.State != "expired" || m.allocated != 0 {
		t.Fatal("expired bodies retained", got, m.allocated)
	}
	if got := m.local(begin); got.Code != "RELAY_OFFLINE" {
		t.Fatal("stale presence accepted", got)
	}
	m.remote(first, relayCommand{Op: "poll"})
	if !m.local(begin).OK {
		t.Fatal("fresh presence refused")
	}
	if got := m.local(relayCommand{Op: "cancel", Owner: first, ID: begin.ID}); !got.OK || got.State != "cancelled" || m.allocated != 0 {
		t.Fatal(got)
	}
	id := strings.Repeat("3", 32)
	relayPublish(t, m.local, first, id, "json", []byte(`{"text":"private"}`))
	filePairing(t, m.clients, []byte("second"))
	if got := m.remote(first, relayCommand{Op: "read", ID: id}); got.Code != "RELAY_UNPAIRED" || got.Data != "" || m.allocated != 0 {
		t.Fatal("revoked data retained or exposed", got)
	}
	now = now.Add(3 * time.Minute)
	m.local(relayCommand{Op: "peers"})
	if len(m.items) != 0 {
		t.Fatal("terminal receipts retained forever")
	}
}

func TestRelayUploadValidationAndFIFO(t *testing.T) {
	m, owner, _ := relayFixture(t)
	now := time.Now()
	m.now = func() time.Time { return now }
	id := strings.Repeat("f", 32)
	body := []byte(`{"text":"hello"}`)
	begin := relayCommand{Op: "begin", Owner: owner, ID: id, Kind: "json", Size: len(body), SHA256: displayOwner(body)}
	if !m.local(begin).OK {
		t.Fatal("begin")
	}
	if got := m.local(relayCommand{Op: "commit", Owner: owner, ID: id}); got.Code != "RELAY_HASH_MISMATCH" {
		t.Fatal("incomplete upload committed")
	}
	for _, c := range []relayCommand{
		{Op: "chunk", Owner: owner, ID: id, Offset: 1, Data: "eA=="},
		{Op: "chunk", Owner: owner, ID: id, Data: "!bad"},
		{Op: "chunk", Owner: owner, ID: id, Data: base64.StdEncoding.EncodeToString(make([]byte, relayChunk+1))},
	} {
		if m.local(c).OK {
			t.Fatal("invalid chunk accepted")
		}
	}
	chunk := relayCommand{Op: "chunk", Owner: owner, ID: id, Data: base64.StdEncoding.EncodeToString(body)}
	if !m.local(chunk).OK {
		t.Fatal("chunk")
	}
	chunk.Data = base64.StdEncoding.EncodeToString([]byte(`{"text":"HELLO"}`))
	if got := m.local(chunk); got.Code != "RELAY_CHUNK_CONFLICT" {
		t.Fatal("conflicting replay accepted")
	}
	begin.SHA256 = strings.Repeat("a", 64)
	if got := m.local(begin); got.Code != "RELAY_ID_CONFLICT" {
		t.Fatal("conflicting begin accepted")
	}
	if !m.local(relayCommand{Op: "commit", Owner: owner, ID: id}).OK {
		t.Fatal("commit")
	}
	relayPublish(t, m.local, owner, strings.Repeat("0", 32), "json", body)
	for i := 0; i < 20; i++ {
		if got := m.remote(owner, relayCommand{Op: "poll"}); got.ID != id {
			t.Fatal("queue ordering unstable", got)
		}
	}
	for _, body := range []string{`{"text":""}`, `{"text":"x","extra":1}`, `{"text":"x\u0000"}`, `{"text":"x"}{}`, "\xff"} {
		if validRelayBody("json", []byte(body)) {
			t.Fatal("invalid text accepted")
		}
	}
	if validRelayBody("jpeg", []byte("not an image")) {
		t.Fatal("invalid jpeg accepted")
	}
	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 40, 30)), nil); err != nil {
		t.Fatal(err)
	}
	if !validRelayBody("jpeg", jpegBytes.Bytes()) {
		t.Fatal("valid jpeg rejected")
	}
}

func TestRelayAuthorizationParsingMatchesPairing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("first")
	pemCert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}))
	for _, enabled := range []any{true, false, "true", "false", "1", 1, 0, nil, []int{1}} {
		data, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": []any{map[string]any{"cert": pemCert, "enabled": enabled}}}})
		os.WriteFile(path, data, 0600)
		_, allowed := relayOwners(path)[displayOwner(cert)]
		if allowed != paired(path, cert) {
			t.Fatal("pairing semantics diverged", enabled)
		}
	}
	filePairing(t, path, cert, cert, cert)
	if len(relayOwners(path)) != 0 {
		t.Fatal("duplicate identity accepted")
	}
}

func TestRelayHTTPRejectsForgedCommandsAndRevocation(t *testing.T) {
	m, owner, _ := relayFixture(t)
	h := m.handler(http.NotFoundHandler())
	for _, cert := range [][]byte{nil, []byte("unknown")} {
		if fileCall(h, cert, "POST", "/v1/relay", `{"op":"poll"}`).Code != 403 {
			t.Fatal("unauthorized")
		}
	}
	for _, body := range []string{`{"op":"peers"}`, `{"op":"begin"}`, `{"op":"poll","owner":"forged"}`, `{"op":"poll","id":"extra"}`, `{"op":"poll"}{}`, `{"op":"read","id":"../x"}`, "{\"op\":\"\xff\"}", strings.Repeat(" ", relayLineLimit+1)} {
		if got := fileCall(h, []byte("first"), "POST", "/v1/relay", body); got.Code != 400 {
			t.Fatal(got.Code, body[:min(80, len(body))])
		}
	}
	id := strings.Repeat("1", 32)
	relayPublish(t, m.local, owner, id, "json", []byte(`{"text":"secret"}`))
	r := httptest.NewRequest("POST", "/v1/relay", &clipboardRevokingReader{Reader: strings.NewReader(`{"op":"read","id":"` + id + `"}`), revoke: func() { filePairing(t, m.clients) }})
	r.Header.Set("Content-Type", "application/json")
	r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: []byte("first")}}}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 || strings.Contains(w.Body.String(), "data") || m.allocated != 0 {
		t.Fatal("body-time revocation ignored", w.Code, w.Body)
	}
}

func TestRelayMutualTLSRoundtripAndConnectionRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	phone, other := fileTestCertificate(t), fileTestCertificate(t)
	filePairing(t, path, phone.Certificate[0])
	m := newRelayMailbox(path)
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(m.handler(http.NotFoundHandler()))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.Config.WriteTimeout = 3 * time.Second
	server.EnableHTTP2 = true
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
		transport := &http.Transport{TLSClientConfig: config, ForceAttemptHTTP2: true}
		t.Cleanup(transport.CloseIdleConnections)
		return &http.Client{Transport: transport, Timeout: 12 * time.Second}
	}
	for _, cert := range []*tls.Certificate{nil, &other} {
		response, err := makeClient(cert).Post(server.URL+"/v1/relay", "application/json", strings.NewReader(`{"op":"poll"}`))
		if err == nil {
			response.Body.Close()
			t.Fatal("unpaired TLS accepted")
		}
	}
	client := makeClient(&phone)
	call := func(command relayCommand) (int, relayReply) {
		t.Helper()
		raw, _ := json.Marshal(command)
		response, err := client.Post(server.URL+"/v1/relay", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var reply relayReply
		if err = json.NewDecoder(response.Body).Decode(&reply); err != nil {
			t.Fatal(err)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable clipboard")
		}
		return response.StatusCode, reply
	}
	if code, reply := call(relayCommand{Op: "poll"}); code != 200 || reply.State != "idle" {
		t.Fatal(code, reply)
	}
	owner := displayOwner(phone.Certificate[0])
	id := strings.Repeat("a", 32)
	body := []byte(`{"text":"` + strings.Repeat("中文", 60000) + `"}`)
	hash := relayPublish(t, m.local, owner, id, "json", body)
	if code, reply := call(relayCommand{Op: "poll"}); code != 200 || reply.ID != id {
		t.Fatal(code, reply)
	}
	var received []byte
	for len(received) < len(body) {
		code, reply := call(relayCommand{Op: "read", ID: id, Offset: len(received)})
		if code != 200 || reply.Offset != len(received) {
			t.Fatal(code, reply)
		}
		chunk, err := base64.StdEncoding.Strict().DecodeString(reply.Data)
		if err != nil || len(chunk) == 0 || len(chunk) > relayReadChunk {
			t.Fatal("chunk bounds")
		}
		received = append(received, chunk...)
	}
	if !bytes.Equal(received, body) {
		t.Fatal("TLS content changed")
	}
	if code, reply := call(relayCommand{Op: "ack", ID: id, SHA256: hash}); code != 200 || reply.State != "delivered" {
		t.Fatal(code, reply)
	}
	filePairing(t, path)
	if code, _ := call(relayCommand{Op: "poll"}); code != 403 {
		t.Fatal("reused TLS bypassed revocation")
	}
}

func TestRelayLocalFramingAndCancellation(t *testing.T) {
	m, _, _ := relayFixture(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { m.serveLocal(ctx, listener); close(done) }()
	for _, request := range []string{"{\"op\":\"peers\"}\n", "{\"op\":\"peers\"}{}\n", strings.Repeat("x", relayLineLimit+1) + "\n", "{\"op\":\"peers\",\"extra\":1}\n"} {
		connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connection.SetDeadline(time.Now().Add(time.Second))
		io.WriteString(connection, request)
		line, err := bufio.NewReader(connection).ReadString('\n')
		connection.Close()
		if request == "{\"op\":\"peers\"}\n" {
			var reply relayReply
			if err != nil || json.Unmarshal([]byte(line), &reply) != nil || !reply.OK || len(reply.Peers) != 2 {
				t.Fatal(line, err)
			}
		} else if err == nil || line != "" {
			t.Fatal("invalid local framing accepted")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("listener survived cancellation")
	}
}

func TestRelayActualWindowsPublisherProtocol(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_RELAY_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_RELAY_TEST_WORKER to the synthetic C# relay test publisher")
	}
	m, owner, _ := relayFixture(t)
	body := []byte(`{"text":"` + strings.Repeat("中文", 4000) + `"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, executable, "--publish")
	in, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := process.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	process.Stderr = &stderr
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		in.Close()
		if process.ProcessState == nil {
			process.Process.Kill()
			process.Wait()
		}
	}()
	encoder := json.NewEncoder(in)
	if err = encoder.Encode(map[string]string{"owner": owner, "kind": "json", "data": base64.StdEncoding.EncodeToString(body)}); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(out)
	count := 0
	finished := false
	for scanner.Scan() {
		var response map[string]json.RawMessage
		if json.Unmarshal(scanner.Bytes(), &response) != nil {
			t.Fatal("invalid publisher output")
		}
		if response["final"] != nil {
			var final string
			json.Unmarshal(response["final"], &final)
			if final != "delivered" {
				t.Fatal(string(scanner.Bytes()))
			}
			finished = true
			break
		}
		var command relayCommand
		if json.Unmarshal(scanner.Bytes(), &command) != nil || command.Owner != owner {
			t.Fatal("invalid publisher command")
		}
		reply := m.local(command)
		count++
		if command.Op == "status" {
			metadata := m.remote(owner, relayCommand{Op: "poll"})
			if metadata.State == "queued" {
				chunk := m.remote(owner, relayCommand{Op: "read", ID: metadata.ID})
				got, _ := base64.StdEncoding.DecodeString(chunk.Data)
				if !bytes.Equal(got, body) {
					t.Fatal("C# publisher changed bytes")
				}
				m.remote(owner, relayCommand{Op: "ack", ID: metadata.ID, SHA256: metadata.SHA256})
			}
		}
		if err = encoder.Encode(reply); err != nil {
			t.Fatal(err)
		}
	}
	in.Close()
	if err = process.Wait(); err != nil || !finished || count < 6 {
		t.Fatal("publisher roundtrip", err, finished, count, stderr.String())
	}
}
