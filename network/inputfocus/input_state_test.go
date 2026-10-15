package inputfocus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func inputFixture() inputState {
	return inputState{Protocol: 1, Instance: testDisplayInstance, Streams: []inputStream{
		{Owner: displayOwner([]byte("first")), ID: 1, Enabled: true, Epoch: 3, Acknowledged: 3, Paused: true},
		{Owner: displayOwner([]byte("second")), ID: 2},
	}}
}
func TestInputStateOwnershipAndReadOnly(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first := []byte("first")
	filePairing(t, clients, first, []byte("second"))
	reads := 0
	h := withInputState(http.NotFoundHandler(), clients, func(context.Context) (inputState, error) { reads++; return inputFixture(), nil })
	for _, cert := range [][]byte{nil, []byte("unpaired")} {
		if w := fileCall(h, cert, "GET", "/v1/input-state", ""); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	for _, path := range []string{"/v1/input-state?owner=second", "/v1/input-state?" + "epoch=2"} {
		if fileCall(h, first, "GET", path, "").Code != 404 {
			t.Fatal("query accepted")
		}
	}
	if fileCall(h, first, "POST", "/v1/input-state", `{"epoch":2}`).Code != 404 || reads != 0 {
		t.Fatal("mutation or unauthenticated read reached engine")
	}
	w := fileCall(h, first, "GET", "/v1/input-state", "")
	var result inputState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || !result.Supported || len(result.Streams) != 1 || result.Streams[0].ID != 1 || result.Streams[0].Exclusive {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"owner"`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("identity leak or cached state")
	}
}
func TestInputStateRejectsImpossibleAcknowledgments(t *testing.T) {
	mutations := []func(*inputState){
		func(s *inputState) { s.Streams[0].Acknowledged = 4 }, func(s *inputState) { s.Streams[0].Acknowledged = 2 },
		func(s *inputState) { s.Streams[0].Paused = false }, func(s *inputState) { s.Streams[0].Enabled = false },
		func(s *inputState) { s.Streams[0].Pending = true }, func(s *inputState) { s.Streams[0].Failed = true },
		func(s *inputState) { s.Streams[0].Exclusive = true }, func(s *inputState) { s.Streams[0].ID = 1 << 53 },
		func(s *inputState) { s.Streams[1].ID = 1 }, func(s *inputState) { s.Streams[0].Owner = "bad" },
	}
	for i, mutate := range mutations {
		s := inputFixture()
		mutate(&s)
		if validInputState(s) {
			t.Fatal("invalid state accepted", i)
		}
	}
	s := inputFixture()
	if !validInputState(s) {
		t.Fatal("valid pause rejected")
	}
	s.Streams[0].Pending = true
	s.Streams[0].Acknowledged = 2
	if !validInputState(s) {
		t.Fatal("pending release rejected")
	}
	s.Streams[0].Closed = true
	if validInputState(s) {
		t.Fatal("closed pending accepted")
	}
}
func TestInputStateRevocationBusyAndOlderEngine(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first := []byte("first")
	filePairing(t, clients, first)
	entered, release := make(chan struct{}), make(chan struct{})
	h := withInputState(http.NotFoundHandler(), clients, func(context.Context) (inputState, error) { close(entered); <-release; return inputFixture(), nil })
	done := make(chan int, 1)
	go func() { done <- fileCall(h, first, "GET", "/v1/input-state", "").Code }()
	<-entered
	if fileCall(h, first, "GET", "/v1/input-state", "").Code != 429 {
		t.Fatal("concurrent request admitted")
	}
	filePairing(t, clients, []byte("second"))
	close(release)
	if <-done != 403 {
		t.Fatal("revoked read disclosed state")
	}
	filePairing(t, clients, first)
	h = withInputState(http.NotFoundHandler(), clients, func(context.Context) (inputState, error) { return inputState{}, errDisplayUnsupported })
	w := fileCall(h, first, "GET", "/v1/input-state", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":false`) {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestInputStateEnginePinAndFixedPath(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		user, password, ok := r.BasicAuth()
		if r.Method != "GET" || r.URL.Path != "/api/cliprelay/input" || !ok || user != "cliprelay" || password != "secret" {
			t.Error("unexpected request")
		}
		_ = json.NewEncoder(w).Encode(inputFixture())
	}))
	defer server.Close()
	if _, err := requestEngineInput(context.Background(), server.URL, "secret", server.Certificate().Raw); err != nil {
		t.Fatal(err)
	}
	if _, err := requestEngineInput(context.Background(), server.URL, "secret", []byte("wrong")); err == nil {
		t.Fatal("bad certificate accepted")
	}
	if reads.Load() != 1 {
		t.Fatal("credentials sent before certificate pin")
	}
}
