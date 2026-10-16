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
func TestTerminalPasteCapabilityAndWholeRequestBounds(t *testing.T) {
	f, h := terminalFixtureNew(t)
	f.result.PasteLimit = 16396
	if fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody()).Code != 200 {
		t.Fatal("paste capability rejected")
	}
	f.result.PasteLimit = 16397
	if fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody()).Code != 503 {
		t.Fatal("unknown capability trusted")
	}
	f.result = terminalReply{OK: true, Instance: terminalTestInstance, Session: &terminalSession{ID: privacyTestLease, Shell: "cmd", State: "running", Columns: 80, Rows: 24, OpenSequence: 1, AcceptedSequence: 1, WrittenSequence: 1}}
	sequence := int64(1)
	r := terminalRequest{Op: "paste", Instance: terminalTestInstance, ID: privacyTestLease, Sequence: &sequence, Data: base64.StdEncoding.EncodeToString([]byte("\x1b[200~" + strings.Repeat("x", 16384) + "\x1b[201~"))}
	call := func(request terminalRequest) int {
		body, _ := json.Marshal(request)
		return fileCall(h, []byte("first"), "POST", "/v1/terminal", string(body)).Code
	}
	if call(r) != 200 {
		t.Fatal("complete 16 KB framed paste rejected by HTTP bound")
	}
	if f.calls[len(f.calls)-1]["data"] != r.Data || f.calls[len(f.calls)-1]["op"] != "paste" {
		t.Fatal("worker payload changed")
	}
	f.result.Session.AcceptedSequence = 0
	if call(r) != 503 {
		t.Fatal("unconfirmed paste accepted")
	}
	before := len(f.calls)
	r.Data = base64.StdEncoding.EncodeToString(make([]byte, 16397))
	if call(r) != 400 {
		t.Fatal("oversized paste accepted")
	}
	r.Op = "write"
	r.Data = base64.StdEncoding.EncodeToString(make([]byte, 4097))
	if call(r) != 400 {
		t.Fatal("write limit expanded")
	}
	r.Op = "paste"
	r.Data = "YQ==\n"
	if call(r) != 400 {
		t.Fatal("noncanonical data accepted")
	}
	if len(f.calls) != before {
		t.Fatal("invalid requests reached worker")
	}
}
func TestTerminalMouseRequestAndReceiptBoundaries(t *testing.T) {
	seq, epoch, gesture := int64(1), int64(3), int64(1)
	good := terminalRequest{Op: "mouse", Instance: terminalTestInstance, ID: privacyTestLease, Sequence: &seq, Epoch: &epoch, Gesture: &gesture, Action: "press", Column: 5, Row: 7}
	if !validTerminalRequest(good) {
		t.Fatal("valid press rejected")
	}
	for _, kind := range []string{"zero-epoch", "missing-gesture", "negative-position", "unknown-action", "extra-data", "extra-offset", "modifier-bit", "press-button", "renew-position", "hover-gesture"} {
		t.Run(kind, func(t *testing.T) {
			r := good
			zero := int64(0)
			switch kind {
			case "zero-epoch":
				r.Epoch = &zero
			case "missing-gesture":
				r.Gesture = nil
			case "negative-position":
				r.Column = -1
			case "unknown-action":
				r.Action = "execute"
			case "extra-data":
				r.Data = "YQ=="
			case "extra-offset":
				r.Offset = &zero
			case "modifier-bit":
				r.Modifiers = 1
			case "press-button":
				r.Button = 3
			case "renew-position":
				r.Action = "renew"
			case "hover-gesture":
				r.Action = "move"
				r.Button = 3
			}
			if validTerminalRequest(r) {
				t.Fatal("invalid mouse command accepted")
			}
		})
	}
	m := terminalMouseState{Mode: 1002, Format: 1006, Epoch: 3, Gesture: 1, NextGesture: 2, AcceptedSequence: 1, Phase: "pending", Outcome: "queued", RemainingMs: 1500}
	s := terminalSession{ID: privacyTestLease, Shell: "cmd", State: "running", Columns: 80, Rows: 24, OpenSequence: 1, Mouse: &m}
	reply := terminalReply{OK: true, Instance: terminalTestInstance, Session: &s}
	if !validTerminalReply(good, reply) {
		t.Fatal("valid accepted mouse receipt rejected")
	}
	m.AcceptedSequence = 0
	if validTerminalReply(good, reply) {
		t.Fatal("mouse acknowledgment not bound to sequence")
	}
	m.AcceptedSequence = 1
	m.Offset = 1
	if validTerminalSession(s) {
		t.Fatal("mode from unseen output accepted")
	}
	m.Offset = 0
	m.Buttons = 8
	if validTerminalSession(s) {
		t.Fatal("unknown pressed button accepted")
	}
	m.Buttons = 0
	m.WrittenSequence = 2
	if validTerminalSession(s) {
		t.Fatal("unaccepted write accepted")
	}
	m.WrittenSequence = 0
	m.Phase = "unknown"
	if validTerminalSession(s) {
		t.Fatal("unknown lifecycle accepted")
	}
}

func TestTerminalMouseRealTLSExpiryAndLostReceipt(t *testing.T) {
	executable, fixture := os.Getenv("CLIPRELAY_TERMINAL_TEST_WORKER"), os.Getenv("CLIPRELAY_TERMINAL_MOUSE_FIXTURE")
	if executable == "" || fixture == "" {
		t.Skip("set terminal worker and mouse fixture for native TLS mouse validation")
	}
	if !filepath.IsAbs(fixture) || strings.ContainsAny(fixture, "\r\n\"") {
		t.Fatal("invalid fixture executable path")
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
	call := func(request terminalRequest, status int) terminalReply {
		t.Helper()
		payload, _ := json.Marshal(request)
		response, err := client.Post(server.URL+"/v1/terminal", "application/json", strings.NewReader(string(payload)))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result terminalReply
		if json.NewDecoder(response.Body).Decode(&result) != nil || response.StatusCode != status {
			t.Fatal(response.StatusCode, result)
		}
		return result
	}
	listed := call(terminalRequest{Op: "list"}, 200)
	if listed.MouseProtocol != 1 {
		t.Fatal("mouse capability missing")
	}
	sequence := int64(1)
	call(terminalRequest{Op: "open", Instance: listed.Instance, ID: privacyTestLease, Shell: "cmd", Columns: 120, Rows: 30, Sequence: &sequence}, 200)
	call(terminalRequest{Op: "write", Instance: listed.Instance, ID: privacyTestLease, Sequence: &sequence, Data: base64.StdEncoding.EncodeToString([]byte("\"" + fixture + "\" --mouse-echo\r"))}, 200)
	offset := int64(0)
	output := ""
	var mouse *terminalMouseState
	read := func() {
		t.Helper()
		result := call(terminalRequest{Op: "read", Instance: listed.Instance, ID: privacyTestLease, Offset: &offset}, 200)
		data, _ := base64.StdEncoding.DecodeString(result.Data)
		output += string(data)
		offset = result.Next
		mouse = result.Session.Mouse
	}
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		read()
		if mouse != nil && mouse.Mode == 1002 && mouse.Format == 1006 && strings.Contains(output, "MOUSE_READY") {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if mouse == nil || mouse.Mode != 1002 || mouse.Format != 1006 {
		t.Fatal("VT mouse mode not observed")
	}
	epoch, gesture := mouse.Epoch, mouse.NextGesture
	command := terminalRequest{Op: "mouse", Instance: listed.Instance, ID: privacyTestLease, Sequence: &sequence, Epoch: &epoch, Gesture: &gesture, Action: "press", Column: 5, Row: 7}
	call(command, 200)
	call(command, 200)
	conflict := command
	conflict.Button = 2
	if call(conflict, 409).Code != "TERMINAL_MOUSE_CONFLICT" {
		t.Fatal("conflicting retry accepted")
	}
	sequence = 2
	command.Action = "move"
	command.Column = 6
	command.Row = 8
	command.Modifiers = 16
	call(command, 200)
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(output, "MOUSE_CAPTURE:") {
		read()
		time.Sleep(25 * time.Millisecond)
	}
	marker := strings.Index(output, "MOUSE_CAPTURE:")
	if marker < 0 {
		t.Fatal("mouse cleanup not received by native application")
	}
	captured := strings.Fields(output[marker+len("MOUSE_CAPTURE:"):])
	if len(captured) == 0 {
		t.Fatal("mouse capture empty")
	}
	actual, err := base64.StdEncoding.DecodeString(captured[0])
	if err != nil || string(actual) != "\x1b[<0;5;7M\x1b[<48;6;8M\x1b[<16;6;8m" {
		t.Fatalf("unexpected native mouse events %q, %v", actual, err)
	}
	if mouse.Buttons != 0 || mouse.AcceptedSequence != 2 || mouse.WrittenSequence != 2 {
		t.Fatal("cleanup receipt inaccurate", mouse)
	}
	sequence = 3
	command.Action = "renew"
	command.Column = 0
	command.Row = 0
	command.Modifiers = 0
	stale := call(command, 409)
	if stale.Code != "TERMINAL_MOUSE_MODE" && stale.Code != "TERMINAL_MOUSE_GESTURE" {
		t.Fatal("expired gesture renewed", stale)
	}
	call(terminalRequest{Op: "close", Instance: listed.Instance, ID: privacyTestLease}, 200)
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
	f.control.cleanupRead = f.control.read
	f.control.read = func(string) (json.RawMessage, error) {
		t.Error("shutdown used cancelled request path")
		return nil, context.Canceled
	}
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
	if listed.PasteLimit != 16396 {
		t.Fatal("native paste capability missing")
	}
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
	sequence = 2
	call(terminalRequest{Op: "write", Instance: listed.Instance, ID: privacyTestLease, Sequence: &sequence, Data: base64.StdEncoding.EncodeToString([]byte("set CLIPRELAY_PASTE_COUNT=0\r"))})
	sequence = 3
	request = terminalRequest{Op: "paste", Instance: listed.Instance, ID: privacyTestLease, Sequence: &sequence, Data: base64.StdEncoding.EncodeToString([]byte(strings.Repeat("rem "+strings.Repeat("x", 5000)+"\r", 3) + "set /a CLIPRELAY_PASTE_COUNT+=1\recho PASTE_COU^NT_%CLIPRELAY_PASTE_COUNT%\r"))}
	call(request)
	call(request)
	text = ""
	deadline = time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(text, "PASTE_COUNT_1") {
		result := call(terminalRequest{Op: "read", Instance: listed.Instance, ID: privacyTestLease, Offset: &offset})
		data, _ := base64.StdEncoding.DecodeString(result.Data)
		text += string(data)
		offset = result.Next
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(text, "PASTE_COUNT_1") || strings.Contains(text, "PASTE_COUNT_2") {
		t.Fatal("long native paste tail missing or replayed")
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
