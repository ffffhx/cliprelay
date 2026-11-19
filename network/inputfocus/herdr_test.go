package inputfocus

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHerdrCloseRequiresExactTerminalIdentity(t *testing.T) {
	created := int64(1793768000000)
	r := herdrRequest{Op: "close", Instance: strings.Repeat("a", 32), ID: strings.Repeat("b", 32), CoreSession: "default", CoreID: "core-identity", Terminal: "t1b", CreatedMS: &created}
	if !validHerdrRequest(r) {
		t.Fatal("valid close rejected")
	}
	for _, change := range []func(*herdrRequest){
		func(v *herdrRequest) { v.Instance = "" }, func(v *herdrRequest) { v.ID = "" },
		func(v *herdrRequest) { v.CoreID = "" }, func(v *herdrRequest) { v.CreatedMS = nil },
		func(v *herdrRequest) { v.Terminal = "alias" }, func(v *herdrRequest) { v.Terminal = "other/t1" },
		func(v *herdrRequest) { v.Text = "exit" }, func(v *herdrRequest) { v.Project = "project" },
		func(v *herdrRequest) { v.CoreSession = "../other" }, func(v *herdrRequest) { v.Op = "watch" },
	} {
		bad := r
		change(&bad)
		if validHerdrRequest(bad) {
			t.Fatalf("invalid close accepted: %+v", bad)
		}
	}
}

func TestHerdrCreationAcceptsCatalogIDsOnly(t *testing.T) {
	r := herdrRequest{Op: "create", ID: strings.Repeat("a", 32), CoreSession: "default", Project: "sp-project", Agent: "codex", Name: "手机会话"}
	if !validHerdrRequest(r) {
		t.Fatal("catalog creation rejected")
	}
	for _, change := range []func(*herdrRequest){
		func(v *herdrRequest) { v.Agent = "powershell.exe -Command exit" },
		func(v *herdrRequest) { v.Project = "" },
		func(v *herdrRequest) { v.Name = "bad\nname" },
		func(v *herdrRequest) { v.Name = strings.Repeat("中", 81) },
		func(v *herdrRequest) { v.Text = "arbitrary command" },
		func(v *herdrRequest) { v.Terminal = "t1" },
		func(v *herdrRequest) { v.Instance = strings.Repeat("b", 32) },
		func(v *herdrRequest) { v.ID = "../file" },
		func(v *herdrRequest) { v.Op = "list" },
	} {
		bad := r
		change(&bad)
		if validHerdrRequest(bad) {
			t.Fatalf("accepted invalid creation: %+v", bad)
		}
	}
}

func TestHerdrGenericAgentCatalogBoundary(t *testing.T) {
	for _, id := range []string{"gemini", "fixture-custom", "cli-123abc", "MyAgent_2"} {
		if !validHerdrAgentID(id) {
			t.Fatal("Generic catalog ID rejected", id)
		}
	}
	for _, id := range []string{"", "../agent", "a;exit", "a --flag", "a\n", strings.Repeat("x", 129)} {
		if validHerdrAgentID(id) {
			t.Fatal("Executable text accepted as ID", id)
		}
	}
	r := herdrRequest{Op: "agents", Query: "my-custom-cli"}
	if !validHerdrRequest(r) {
		t.Fatal("CLI search rejected")
	}
	r.Text = "execute this"
	if validHerdrRequest(r) {
		t.Fatal("Search accepted a command")
	}
	r.Text = ""
	r.Query = "bad\nquery"
	if validHerdrRequest(r) {
		t.Fatal("Search accepted controls")
	}
}

func TestHerdrThroughWindowsLocalPairingTLSService(t *testing.T) {
	executable := buildProbeOwnerFixture(t)
	directory, cert, access := hostServerFixture(t)
	journal := filepath.Join(directory, "herdr-worker.jsonl")
	t.Setenv("CLIPRELAY_HERDR_FIXTURE_JOURNAL", journal)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listeners, err := listenHost(ctx, hostLoopbackConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer listeners.close()
	ready, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		_ = serveWithLocalPairing(ctx, directory, executable, access,
			func(context.Context, string) (*hostListeners, error) { return listeners, nil },
			func() error { close(ready); return nil })
	}()
	t.Cleanup(func() { cancel(); waitHostSignal(t, finished, "Herdr service teardown") })
	waitHostSignal(t, ready, "Herdr service readiness")
	client := hostFixtureClient(t, cert)
	url := "https://" + listeners.control.Addr().String() + "/v1/herdr"
	response, err := client.Post(url, "application/json", strings.NewReader(`{"op":"list"}`))
	if err != nil {
		t.Fatal(err)
	}
	var reply herdrReply
	err = json.NewDecoder(response.Body).Decode(&reply)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !reply.OK {
		t.Fatalf("Windows local-pairing service did not reach Herdr worker: HTTP %d, %+v, %v", response.StatusCode, reply, err)
	}
	var result struct {
		Owner     string
		Terminals []struct{ Address string }
	}
	if json.Unmarshal(reply.Result, &result) != nil || len(result.Terminals) != 1 || result.Terminals[0].Address != "t1" || result.Owner != displayOwner(cert.Certificate[0]) {
		t.Fatal("actual TLS certificate identity or worker reply lost", string(reply.Result))
	}
	// Keep the TLS connection open while revoking its certificate: each request
	// still has to check the current registry rather than trust the handshake.
	filePairing(t, filepath.Join(directory, "clients.json"))
	response, err = client.Post(url, "application/json", strings.NewReader(`{"op":"list"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("revoked TLS client retained Herdr access", response.StatusCode)
	}
	cancel()
	waitHostSignal(t, finished, "Herdr service cancellation")
	file, err := os.Open(journal)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	lists := 0
	var last map[string]any
	for scanner.Scan() {
		if json.Unmarshal(scanner.Bytes(), &last) != nil {
			t.Fatal("invalid worker journal")
		}
		if last["op"] == "list" {
			lists++
		}
	}
	if scanner.Err() != nil {
		t.Fatal(scanner.Err())
	}
	owners, ok := last["owners"].([]any)
	if lists != 1 || last["op"] != "sync" || !ok || len(owners) != 0 {
		t.Fatal("revocation reached worker or teardown did not withdraw authorization", lists, last)
	}
	assertHostPortsFree(t, listeners)
}

func TestHerdrPairedBoundaryAndRevocation(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, clients, []byte("phone"))
	var calls []map[string]any
	revoke := false
	h := &herdrControl{clients: clients, read: func(raw string) (json.RawMessage, error) {
		var value map[string]any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, value)
		if value["op"] != "sync" && revoke {
			filePairing(t, clients)
		}
		return json.Marshal(herdrReply{OK: true, Instance: terminalTestInstance, Result: json.RawMessage(`{"terminals":[]}`)})
	}}
	handler := h.handler(http.NotFoundHandler())
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if result := fileCall(handler, peer, "POST", "/v1/herdr", `{"op":"list"}`); result.Code != 403 {
			t.Fatal(result.Code)
		}
	}
	for _, body := range []string{`{"op":"chat","coreSession":"default","terminal":"t1"}`, `{"op":"sync","owners":[]}`, `{"op":"list","owner":"fake"}`, `{"op":"terminal.kill","terminal":"t1"}`, `{"op":"list","coreSession":"../other"}`, `{"op":"list"}{}`, `{"op":"list","instance":"wrong"}`} {
		if result := fileCall(handler, []byte("phone"), "POST", "/v1/herdr", body); result.Code != 400 {
			t.Fatal(body, result.Code)
		}
	}
	if len(calls) != 0 {
		t.Fatal("invalid request reached worker")
	}
	result := fileCall(handler, []byte("phone"), "POST", "/v1/herdr", `{"op":"list"}`)
	if result.Code != 200 || result.Header().Get("Cache-Control") != "no-store" || calls[1]["owner"] != displayOwner([]byte("phone")) {
		t.Fatal("certificate scope lost", result.Body.String())
	}
	revoke = true
	result = fileCall(handler, []byte("phone"), "POST", "/v1/herdr", `{"op":"list"}`)
	if result.Code != 403 {
		t.Fatal("data escaped after revocation", result.Body.String())
	}
	if len(calls[len(calls)-1]["owners"].([]any)) != 0 {
		t.Fatal("revoked viewers not detached")
	}
}

func TestHerdrDoesNotReplayWorkerFailure(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, clients, []byte("phone"))
	count := 0
	h := &herdrControl{clients: clients, read: func(raw string) (json.RawMessage, error) {
		var value map[string]any
		_ = json.Unmarshal([]byte(raw), &value)
		if value["op"] == "sync" {
			return json.Marshal(herdrReply{OK: true, Instance: terminalTestInstance})
		}
		count++
		return json.RawMessage(`{"ok":true,"instance":"new-worker"}`), nil
	}}
	result := fileCall(h.handler(http.NotFoundHandler()), []byte("phone"), "POST", "/v1/herdr", `{"op":"send","instance":"`+terminalTestInstance+`","id":"`+privacyTestLease+`","sequence":1,"text":"continue"}`)
	if result.Code != 503 || count != 1 || !strings.Contains(result.Body.String(), "HERDR_OUTCOME_UNKNOWN") {
		t.Fatal(count, result.Body.String())
	}
}

func TestHerdrInputBounds(t *testing.T) {
	seq := int64(1)
	valid := herdrRequest{Op: "send", Instance: terminalTestInstance, ID: privacyTestLease, Sequence: &seq, Text: "继续检查\n第二行"}
	if !validHerdrRequest(valid) {
		t.Fatal("valid text rejected")
	}
	for _, text := range []string{"", strings.Repeat("x", 16385), "bad\x1b[20h", "bad\x00"} {
		r := valid
		r.Text = text
		if validHerdrRequest(r) {
			t.Fatal("accepted invalid input")
		}
	}
	r := valid
	r.Keys = []string{"enter"}
	if validHerdrRequest(r) {
		t.Fatal("mixed operations")
	}
	r = valid
	r.Op = "keys"
	r.Text = ""
	r.Keys = []string{"ctrl+c", "enter", "up", "shift+left"}
	if !validHerdrRequest(r) {
		t.Fatal("valid keys")
	}
	r.Keys = []string{"$(whoami)"}
	if validHerdrRequest(r) {
		t.Fatal("invalid key")
	}
	for _, key := range []string{"shift+", "shift+left\n", "shift+exec", "ctrl+shift+left"} {
		r.Keys = []string{key}
		if validHerdrRequest(r) {
			t.Fatalf("unsupported chord accepted: %q", key)
		}
	}
}

func TestHerdrAbsentProviderIsExplicitAndDoesNotStartAWorker(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, clients, []byte("phone"))
	h := &herdrControl{clients: clients, unsupported: true, read: func(string) (json.RawMessage, error) {
		t.Fatal("unsupported provider launched a worker")
		return nil, nil
	}}
	result := fileCall(h.handler(http.NotFoundHandler()), []byte("phone"), "POST", "/v1/herdr", `{"op":"list"}`)
	if result.Code != 501 || !strings.Contains(result.Body.String(), "HERDR_UNSUPPORTED") {
		t.Fatal("phone cannot distinguish unsupported platform from a disconnected host", result.Code, result.Body.String())
	}
}
