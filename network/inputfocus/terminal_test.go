package inputfocus

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const terminalTestInstance = "11111111111111111111111111111111"

func terminalListBody() string { return `{"op":"list"}` }

type terminalFixture struct {
	control *terminalControl
	calls   []map[string]any
	result  terminalReply
	onRead  func()
}

func terminalFixtureNew(t *testing.T) (*terminalFixture, http.Handler) {
	f := &terminalFixture{result: terminalReply{OK: true, Instance: terminalTestInstance, NextOpen: 1, Sessions: []terminalSession{}}}
	f.control = &terminalControl{clients: filepath.Join(t.TempDir(), "clients.json"), read: func(body string) (json.RawMessage, error) {
		var request map[string]any
		if json.Unmarshal([]byte(body), &request) != nil {
			t.Fatal("invalid worker payload")
		}
		f.calls = append(f.calls, request)
		if request["op"] == "sync" {
			return json.Marshal(terminalReply{OK: true, Instance: terminalTestInstance})
		}
		if f.onRead != nil {
			f.onRead()
		}
		return json.Marshal(f.result)
	}}
	filePairing(t, f.control.clients, []byte("first"), []byte("second"))
	return f, f.control.handler(http.NotFoundHandler())
}
func TestTerminalAuthenticationAndStrictInput(t *testing.T) {
	f, h := terminalFixtureNew(t)
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if fileCall(h, peer, "POST", "/v1/terminal", terminalListBody()).Code != 403 {
			t.Fatal("unpaired")
		}
	}
	for _, bad := range []string{`{"op":"sync","owners":[]}`, `{"op":"list","owner":"other"}`, `{"op":"list","data":"YQ=="}`, `{"op":"list"}{}`, `{"op":"execute","command":"whoami"}`} {
		if fileCall(h, []byte("first"), "POST", "/v1/terminal", bad).Code != 400 {
			t.Fatal("accepted invalid operation", bad)
		}
	}
	if len(f.calls) != 0 {
		t.Fatal("invalid calls reached worker")
	}
	response := fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody())
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(response.Code, response.Body.String())
	}
	if f.calls[1]["owner"] != displayOwner([]byte("first")) {
		t.Fatal("owner not injected from certificate")
	}
}
func TestTerminalOwnersRejectRevokedAmbiguousAndMalformedPairings(t *testing.T) {
	f, _ := terminalFixtureNew(t)
	owners, err := terminalOwners(f.control.clients)
	if err != nil || len(owners) != 2 {
		t.Fatal(owners, err)
	}
	filePairing(t, f.control.clients, []byte("first"), []byte("first"), []byte("second"))
	owners, err = terminalOwners(f.control.clients)
	if err != nil || len(owners) != 1 || owners[0] != displayOwner([]byte("second")) {
		t.Fatal("duplicate identity authorized", owners)
	}
	if err = os.WriteFile(f.control.clients, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if f.control.syncLocked(false) == nil {
		t.Fatal("corrupt registry authorized")
	}
	if len(f.calls[0]["owners"].([]any)) != 0 {
		t.Fatal("authorization not withdrawn")
	}
}
func TestTerminalInputAndOutputBounds(t *testing.T) {
	seq := int64(1)
	offset := int64(0)
	good := terminalRequest{Op: "write", Instance: terminalTestInstance, ID: privacyTestLease, Sequence: &seq, Data: base64.StdEncoding.EncodeToString([]byte("hello\r"))}
	if !validTerminalRequest(good) {
		t.Fatal("valid input")
	}
	for _, kind := range []string{"future-sequence", "empty", "too-large", "invalid-base64", "missing-instance", "extra-shell", "extra-offset"} {
		t.Run(kind, func(t *testing.T) {
			r := good
			switch kind {
			case "future-sequence":
				number := int64(1 << 53)
				r.Sequence = &number
			case "empty":
				r.Data = ""
			case "too-large":
				r.Data = base64.StdEncoding.EncodeToString(make([]byte, 4097))
			case "invalid-base64":
				r.Data = "YQ==\n"
			case "missing-instance":
				r.Instance = ""
			case "extra-shell":
				r.Shell = "cmd"
			case "extra-offset":
				r.Offset = &offset
			}
			if validTerminalRequest(r) {
				t.Fatal("invalid input accepted")
			}
		})
	}
	request := terminalRequest{Op: "read", Instance: terminalTestInstance, ID: privacyTestLease, Offset: &offset}
	reply := terminalReply{OK: true, Instance: terminalTestInstance, Session: &terminalSession{ID: privacyTestLease, Shell: "cmd", State: "running", Columns: 80, Rows: 24, OpenSequence: 1, End: 3, RemainingMs: 1800000}, Data: "YWJj", Next: 3}
	if !validTerminalReply(request, reply) {
		t.Fatal("valid read rejected")
	}
	reply.Next = 4
	if validTerminalReply(request, reply) {
		t.Fatal("offset not bound to bytes")
	}
	reply.Next = 3
	reply.Session.ID = strings.Repeat("f", 32)
	if validTerminalReply(request, reply) {
		t.Fatal("other session output accepted")
	}
}
func TestTerminalRevocationDuringReadWithdrawsWorkerAuthority(t *testing.T) {
	f, h := terminalFixtureNew(t)
	f.onRead = func() { filePairing(t, f.control.clients, []byte("second")) }
	response := fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody())
	if response.Code != 403 || len(f.calls) != 3 {
		t.Fatal(response.Code, f.calls)
	}
	owners := f.calls[2]["owners"].([]any)
	if len(owners) != 1 || owners[0] != displayOwner([]byte("second")) {
		t.Fatal("revoked sessions not withdrawn")
	}
}
func TestTerminalMalformedStateAndBusyFailClosed(t *testing.T) {
	for _, kind := range []string{"instance", "sequence", "shell", "id", "offset"} {
		t.Run(kind, func(t *testing.T) {
			f, h := terminalFixtureNew(t)
			s := terminalSession{ID: privacyTestLease, Shell: "cmd", State: "running", Columns: 80, Rows: 24, OpenSequence: 1, RemainingMs: 1}
			f.result.NextOpen = 2
			f.result.Sessions = []terminalSession{s}
			switch kind {
			case "instance":
				f.result.Instance = "bad"
			case "sequence":
				f.result.NextOpen = 1
			case "shell":
				f.result.Sessions[0].Shell = "executable"
			case "id":
				f.result.Sessions[0].ID = "bad"
			case "offset":
				f.result.Sessions[0].End = -1
			}
			if fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody()).Code != 503 {
				t.Fatal("invalid state disclosed")
			}
		})
	}
	f, h := terminalFixtureNew(t)
	f.control.mu.Lock()
	defer f.control.mu.Unlock()
	if fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody()).Code != 429 || len(f.calls) != 0 {
		t.Fatal("concurrent commands allowed")
	}
}
func TestTerminalShutdownWithdrawsAllSessions(t *testing.T) {
	f, _ := terminalFixtureNew(t)
	f.control.started = true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.control.maintain(ctx)
	if len(f.calls) != 1 || len(f.calls[0]["owners"].([]any)) != 0 {
		t.Fatal("shutdown kept sessions")
	}
}
func TestTerminalRealTLSNativeWorkerReconnectAndRevocation(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_TERMINAL_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_TERMINAL_TEST_WORKER for bounded ConPTY acceptance")
	}
	worker := &probe{executable: executable, argument: "--terminal-probe", maxOutput: 65536, timeout: 8 * time.Second}
	defer worker.stop()
	clients := filepath.Join(t.TempDir(), "clients.json")
	cert := fileTestCertificate(t)
	filePairing(t, clients, cert.Certificate[0])
	control := &terminalControl{clients: clients, read: worker.read}
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(control.handler(http.NotFoundHandler()))
	server.TLS = controlTLSConfig(host, clients)
	server.StartTLS()
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.Certificates = []tls.Certificate{cert}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	call := func(request terminalRequest) terminalReply {
		t.Helper()
		payload, _ := json.Marshal(request)
		response, err := client.Post(server.URL+"/v1/terminal", "application/json", strings.NewReader(string(payload)))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result terminalReply
		if json.NewDecoder(response.Body).Decode(&result) != nil || response.StatusCode != 200 {
			t.Fatal(response.StatusCode, result)
		}
		return result
	}
	listed := call(terminalRequest{Op: "list"})
	sequence := listed.NextOpen
	opened := call(terminalRequest{Op: "open", Instance: listed.Instance, ID: privacyTestLease, Shell: "cmd", Columns: 80, Rows: 24, Sequence: &sequence})
	if opened.Session.State != "running" {
		t.Fatal(opened)
	}
	// A new HTTP/TLS connection attaches to the same still-running session.
	transport.CloseIdleConnections()
	again := call(terminalRequest{Op: "list"})
	if len(again.Sessions) != 1 || again.Sessions[0].ID != privacyTestLease {
		t.Fatal("session lost on reconnect")
	}
	sequence = 1
	request := terminalRequest{Op: "write", Instance: listed.Instance, ID: privacyTestLease, Sequence: &sequence, Data: base64.StdEncoding.EncodeToString([]byte("echo TLS_%COMSPEC:~-7%\r"))}
	call(request)
	call(request)
	offset := int64(0)
	text := ""
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(strings.ToLower(text), "tls_cmd.exe") {
		result := call(terminalRequest{Op: "read", Instance: listed.Instance, ID: privacyTestLease, Offset: &offset})
		bytes, err := base64.StdEncoding.DecodeString(result.Data)
		if err != nil {
			t.Fatal(err)
		}
		text += string(bytes)
		offset = result.Next
		if !strings.Contains(strings.ToLower(text), "tls_cmd.exe") {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if strings.Count(strings.ToLower(text), "tls_cmd.exe") != 1 {
		t.Fatal("missing or repeated command result")
	}
	filePairing(t, clients, []byte("replacement"))
	control.mu.Lock()
	err := control.syncLocked(false)
	control.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	// Inspect only the test worker after restoring its synthetic authorization.
	filePairing(t, clients, cert.Certificate[0])
	ended := call(terminalRequest{Op: "list"})
	if ended.Sessions[0].State != "revoked" {
		t.Fatal("revocation left shell running")
	}
	command := worker.cmd
	worker.stop()
	if command.ProcessState == nil || !command.ProcessState.Success() {
		t.Fatal("worker did not exit on EOF")
	}
	t.Log("Real paired TLS, unprivileged ConPTY, reconnection and revocation verified; only isolated test commands executed")
}
