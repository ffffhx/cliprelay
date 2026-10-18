package inputfocus

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func bitrateFixture() bitrateState {
	return bitrateState{Protocol: 1, Instance: testDisplayInstance, Streams: []bitrateStream{
		{Owner: displayOwner([]byte("first")), ID: 10, Revision: 3, Supported: true, Budget: 5000, Video: 3500},
		{Owner: displayOwner([]byte("second")), ID: 11, Revision: 9, Supported: true, Budget: 8000, Video: 5500},
	}}
}

const bitrateBody = `{"instance":"` + testDisplayInstance + `","stream":10,"revision":3,"budgetKbps":2000}`

func TestBitrateOwnershipStalenessAndBounds(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first"), []byte("second")
	filePairing(t, clients, first, second)
	reads, posts := 0, 0
	state := bitrateFixture()
	h := withBitrate(http.NotFoundHandler(), clients, func(_ context.Context, owner string, selection *bitrateSelection) (bitrateState, error) {
		if selection == nil {
			reads++
			return state, nil
		}
		posts++
		if owner != displayOwner(first) || selection.Stream != 10 || selection.Budget != 2000 {
			t.Fatal("owner or request changed")
		}
		result := bitrateFixture()
		result.Accepted = true
		result.Streams[0].Result, result.Streams[0].RequestID = "pending", 1
		return result, nil
	})
	for _, cert := range [][]byte{nil, []byte("unpaired")} {
		if fileCall(h, cert, "GET", "/v1/bitrate", "").Code != 403 {
			t.Fatal("unpaired read")
		}
	}
	if reads != 0 {
		t.Fatal("unpaired request reached engine")
	}
	w := fileCall(h, first, "GET", "/v1/bitrate", "")
	var filtered bitrateState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &filtered) != nil || !filtered.Supported || len(filtered.Streams) != 1 || filtered.Streams[0].ID != 10 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"owner"`) || strings.Contains(w.Body.String(), `"id":11`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("another stream or identity leaked")
	}
	for _, body := range []string{
		strings.Replace(bitrateBody, `2000}`, `2000,"owner":"spoof"}`, 1),
		bitrateBody + `{}`, strings.Replace(bitrateBody, "2000", "499", 1),
		strings.Replace(bitrateBody, "2000", "150001", 1), strings.Replace(bitrateBody, "2000", "2.1", 1),
		strings.Replace(bitrateBody, `"revision":3`, `"revision":-1`, 1), strings.Repeat("x", 1025),
	} {
		if fileCall(h, first, "POST", "/v1/bitrate", body).Code != 400 {
			t.Fatal(body)
		}
	}
	if fileCall(h, second, "POST", "/v1/bitrate", bitrateBody).Code != 403 {
		t.Fatal("another client retargeted stream")
	}
	if fileCall(h, first, "POST", "/v1/bitrate", strings.Replace(bitrateBody, `"revision":3`, `"revision":2`, 1)).Code != 409 {
		t.Fatal("stale revision")
	}
	state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
	if fileCall(h, first, "POST", "/v1/bitrate", bitrateBody).Code != 409 {
		t.Fatal("stale engine")
	}
	if posts != 0 {
		t.Fatal("rejected request mutated engine")
	}
	state = bitrateFixture()
	w = fileCall(h, first, "POST", "/v1/bitrate", bitrateBody)
	if w.Code != 200 || posts != 1 || !strings.Contains(w.Body.String(), `"result":"pending"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestBitrateRevocationAndBusy(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first"), []byte("second")
	filePairing(t, clients, first, second)
	entered, release := make(chan struct{}), make(chan struct{})
	posts := 0
	h := withBitrate(http.NotFoundHandler(), clients, func(_ context.Context, _ string, selection *bitrateSelection) (bitrateState, error) {
		if selection != nil {
			posts++
		}
		close(entered)
		<-release
		return bitrateFixture(), nil
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- fileCall(h, first, "POST", "/v1/bitrate", bitrateBody) }()
	<-entered
	if fileCall(h, second, "GET", "/v1/bitrate", "").Code != 429 {
		t.Fatal("unbounded concurrent requests")
	}
	filePairing(t, clients, second)
	close(release)
	if w := <-done; w.Code != 403 || posts != 0 {
		t.Fatal("revoked request mutated engine")
	}
}

func TestBitrateEngineRequestAndFailClosed(t *testing.T) {
	mode := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "cliprelay" || password != "secret" || r.URL.Path != "/api/cliprelay/bitrate" {
			t.Error("wrong engine request")
		}
		if r.Method == "POST" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body) != 5 || body["owner"] != displayOwner([]byte("first")) || body["budgetKbps"] != float64(2000) {
				t.Error("owner missing or budget changed")
			}
		}
		switch mode {
		case 1:
			http.NotFound(w, r)
		case 2:
			http.Redirect(w, r, "https://example.invalid/credentials", 302)
		case 3:
			_, _ = w.Write([]byte(strings.Repeat("x", 65537)))
		case 4:
			state := bitrateFixture()
			state.Streams[1].ID = 10
			_ = json.NewEncoder(w).Encode(state)
		default:
			_ = json.NewEncoder(w).Encode(bitrateFixture())
		}
	}))
	defer server.Close()
	var selection bitrateSelection
	_ = json.Unmarshal([]byte(bitrateBody), &selection)
	for _, request := range []*bitrateSelection{nil, &selection} {
		state, err := requestEngineBitrate(context.Background(), server.URL, "secret", server.Certificate().Raw, displayOwner([]byte("first")), request)
		if err != nil || !state.Supported {
			t.Fatal(err)
		}
	}
	if _, err := requestEngineBitrate(context.Background(), server.URL, "secret", []byte("wrong pin"), "", nil); err == nil {
		t.Fatal("wrong pin trusted")
	}
	for mode = 1; mode <= 4; mode++ {
		_, err := requestEngineBitrate(context.Background(), server.URL, "secret", server.Certificate().Raw, "", nil)
		if err == nil || (mode == 1 && !errors.Is(err, errDisplayUnsupported)) {
			t.Fatal(mode, err)
		}
	}
}

func TestBitrateLegacyHostAndRevocationAfterPost(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first := []byte("first")
	filePairing(t, clients, first)
	h := withBitrate(http.NotFoundHandler(), clients, func(context.Context, string, *bitrateSelection) (bitrateState, error) {
		return bitrateState{}, errDisplayUnsupported
	})
	w := fileCall(h, first, "GET", "/v1/bitrate", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":false`) {
		t.Fatal(w.Body.String())
	}
	h = withBitrate(http.NotFoundHandler(), clients, func(_ context.Context, _ string, request *bitrateSelection) (bitrateState, error) {
		state := bitrateFixture()
		if request != nil {
			filePairing(t, clients)
			state.Accepted = true
		}
		return state, nil
	})
	if w = fileCall(h, first, "POST", "/v1/bitrate", bitrateBody); w.Code != 403 || strings.Contains(w.Body.String(), "streams") {
		t.Fatal("revoked response leaked")
	}
}
