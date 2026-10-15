package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const testDisplayInstance = "ABCDEF01-2345-ABCD-EF01-23456789ABCD"

func displayOwner(cert []byte) string {
	hash := sha256.Sum256(cert)
	return hex.EncodeToString(hash[:])
}

func displayFixture(first, second []byte) displayState {
	return displayState{Protocol: 1, Instance: testDisplayInstance, Revision: 12, Generation: 2, Phase: "active", Displays: []string{"left", "right"},
		Capture: &displayGeometry{"left", -1920, 0, 1920, 1080, -1920, 0, 3840, 1080},
		Streams: []displayStream{
			{displayOwner(first), 10, 2, 1280, 720, 150, nil},
			{displayOwner(second), 11, 2, 1920, 1080, 30, nil},
		}}
}

func TestDisplaysValidateAndFilterAudioReadiness(t *testing.T) {
	first, second := []byte("first"), []byte("second")
	state := displayFixture(first, second)
	if !validDisplayState(state) {
		t.Fatal("older engine without audio metadata rejected")
	}
	for _, audio := range []displayAudio{{"", 1, false}, {"", 0, true}, {"endpoint", 1, true}, {"endpoint", 0, false}, {"process", 0, true}, {"unknown", 1, false}} {
		state.Streams[0].Audio = &audio
		if validDisplayState(state) {
			t.Fatalf("unsafe audio metadata accepted: %+v", audio)
		}
	}
	state.Streams[0].Audio = &displayAudio{"process", 3, true}
	state.Streams[1].Audio = &displayAudio{"endpoint", 4, false}
	if !validDisplayState(state) {
		t.Fatal("valid audio metadata rejected")
	}
	for _, owner := range []string{displayOwner(first), displayOwner(second)} {
		filtered := filterDisplayState(state, owner)
		if len(filtered.Streams) != 1 || filtered.Streams[0].Audio == nil || filtered.Streams[0].Audio.Ready != (owner == displayOwner(first)) {
			t.Fatal("another client's audio readiness leaked", filtered.Streams)
		}
	}
}

func TestDisplaysBindSelectionToCurrentPairedStream(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first"), []byte("second")
	filePairing(t, clients, first, second)
	state := displayFixture(first, second)
	posts, reads := 0, 0
	h := withDisplays(http.NotFoundHandler(), clients, func(_ context.Context, refresh bool, selection *displaySelection) (displayState, error) {
		if selection == nil {
			reads++
			return state, nil
		}
		posts++
		if selection.Stream != 10 || selection.Display != "right" || selection.Revision != 12 {
			t.Fatal("selection was changed")
		}
		result := state
		result.Accepted, result.Phase, result.Result = true, "switching", "pending"
		return result, nil
	})
	for _, peer := range [][]byte{nil, []byte("unpaired")} {
		if fileCall(h, peer, "GET", "/v1/displays", "").Code != 403 {
			t.Fatal("unauthenticated display access")
		}
	}
	if reads != 0 {
		t.Fatal("unpaired request reached engine")
	}
	w := fileCall(h, first, "GET", "/v1/displays?refresh=1", "")
	var filtered displayState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &filtered) != nil || len(filtered.Streams) != 1 || filtered.Streams[0].ID != 10 || !filtered.Shared || !filtered.Supported {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), displayOwner(second)) || strings.Contains(w.Body.String(), `"owner"`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("identity leaked or response cached")
	}
	for _, body := range []string{
		`{"instance":"` + testDisplayInstance + `","display":"right","revision":12,"stream":10,"owner":"spoof"}`,
		`{"instance":"` + testDisplayInstance + `","display":"right","revision":12,"stream":10}{}`,
		`{"instance":"` + testDisplayInstance + `","display":"right","revision":-1,"stream":10}`,
		`{"instance":"` + testDisplayInstance + `","display":"right","revision":12,"stream":0}`,
		`{"display":"right","revision":12,"stream":10}`,
	} {
		if fileCall(h, first, "POST", "/v1/displays", body).Code != 400 {
			t.Fatal(body)
		}
	}
	if fileCall(h, second, "POST", "/v1/displays", `{"instance":"`+testDisplayInstance+`","display":"right","revision":12,"stream":10}`).Code != 403 {
		t.Fatal("another client's stream controlled")
	}
	if fileCall(h, first, "POST", "/v1/displays", `{"instance":"`+testDisplayInstance+`","display":"right","revision":11,"stream":10}`).Code != 409 {
		t.Fatal("stale snapshot accepted")
	}
	if posts != 0 {
		t.Fatal("invalid request reached selection endpoint")
	}
	w = fileCall(h, first, "POST", "/v1/displays", `{"instance":"`+testDisplayInstance+`","display":"right","revision":12,"stream":10}`)
	if w.Code != 200 || posts != 1 || !strings.Contains(w.Body.String(), `"phase":"switching"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	// Another client's ready encoder must not make this client's new binding ready.
	state.Streams[0].FirstFrame = 0
	w = fileCall(h, first, "GET", "/v1/displays", "")
	if !strings.Contains(w.Body.String(), `"phase":"starting"`) {
		t.Fatal(w.Body.String())
	}
	state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
	if fileCall(h, first, "POST", "/v1/displays", `{"instance":"`+testDisplayInstance+`","display":"right","revision":12,"stream":10}`).Code != 409 || posts != 1 {
		t.Fatal("request for a previous engine instance was forwarded")
	}
}

func TestDisplaysRevocationAndBusy(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first"), []byte("second")
	filePairing(t, clients, first, second)
	entered, release := make(chan struct{}), make(chan struct{})
	h := withDisplays(http.NotFoundHandler(), clients, func(context.Context, bool, *displaySelection) (displayState, error) {
		close(entered)
		<-release
		return displayFixture(first, second), nil
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- fileCall(h, first, "GET", "/v1/displays", "") }()
	<-entered
	if fileCall(h, second, "GET", "/v1/displays", "").Code != 429 {
		t.Fatal("concurrent engine access not bounded")
	}
	filePairing(t, clients, second)
	close(release)
	if w := <-done; w.Code != 403 || strings.Contains(w.Body.String(), "left") {
		t.Fatal("revoked client received state")
	}
}

func TestDisplayEnginePinRedirectAndResponseBounds(t *testing.T) {
	var mode atomic.Int32
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer destination.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "cliprelay" || password != "test-secret" {
			t.Error("missing engine credentials")
		}
		switch mode.Load() {
		case 1:
			http.Redirect(w, r, destination.URL, 302)
		case 2:
			_, _ = w.Write([]byte(strings.Repeat("x", 64*1024+1)))
		case 3:
			http.NotFound(w, r)
		case 4:
			value, _ := json.Marshal(displayFixture([]byte("a"), []byte("b")))
			var extra map[string]any
			_ = json.Unmarshal(value, &extra)
			extra["adminPassword"] = "test-secret"
			_ = json.NewEncoder(w).Encode(extra)
		default:
			if r.Method == "POST" {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if len(body) != 3 || body["stream"] != nil || body["instance"] != testDisplayInstance {
					t.Error("client-only metadata sent to admin endpoint")
				}
			}
			_ = json.NewEncoder(w).Encode(displayFixture([]byte("a"), []byte("b")))
		}
	}))
	defer server.Close()
	call := func(cert []byte) (displayState, error) {
		return requestEngineDisplay(context.Background(), server.URL, "test-secret", cert, false, &displaySelection{Instance: testDisplayInstance, Display: "right", Revision: 12, Stream: 10})
	}
	if _, err := call([]byte("wrong pinned certificate")); err == nil {
		t.Fatal("untrusted host accepted")
	}
	if state, err := call(server.Certificate().Raw); err != nil || state.Capture.X != -1920 {
		t.Fatal(state, err)
	}
	for _, bad := range []int32{1, 2} {
		mode.Store(bad)
		if _, err := call(server.Certificate().Raw); err == nil {
			t.Fatal("redirect/oversized response accepted")
		}
	}
	if redirected.Load() != 0 {
		t.Fatal("credentials followed redirect")
	}
	mode.Store(3)
	if _, err := call(server.Certificate().Raw); !errors.Is(err, errDisplayUnsupported) {
		t.Fatal(err)
	}
	mode.Store(4)
	state, err := call(server.Certificate().Raw)
	encoded, _ := json.Marshal(state)
	if err != nil || strings.Contains(string(encoded), "test-secret") {
		t.Fatal("unknown engine fields leaked")
	}
}

func TestDisplayUnsupportedAndMalformedProvider(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, clients, cert)
	mode := 0
	h := withDisplays(http.NotFoundHandler(), clients, func(context.Context, bool, *displaySelection) (displayState, error) {
		if mode == 0 {
			return displayState{}, errDisplayUnsupported
		}
		if mode == 1 {
			return displayState{}, errors.New("private credentials/path must not escape")
		}
		state := displayFixture(cert, cert)
		state.Capture.X = 9000000
		return state, nil
	})
	w := fileCall(h, cert, "GET", "/v1/displays", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":false`) || !strings.Contains(w.Body.String(), "DISPLAY_UNSUPPORTED") {
		t.Fatal(w.Body.String())
	}
	for _, invalid := range []int{1, 2} {
		mode = invalid
		w = fileCall(h, cert, "GET", "/v1/displays", "")
		if w.Code != 503 || strings.Contains(w.Body.String(), "private") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
