package inputfocus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestDisplayInputEpochRequiresCapabilityAndExclusivePairedStream(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first, second := []byte("first"), []byte("second")
	filePairing(t, clients, first, second)
	state := displayFixture(first, second)
	state.Streams = state.Streams[:1]
	posts := 0
	handler := withDisplays(http.NotFoundHandler(), clients, func(_ context.Context, _ bool, selection *displaySelection) (displayState, error) {
		if selection == nil {
			return state, nil
		}
		posts++
		epoch, valid := displayInputEpoch(selection)
		if !valid || epoch != 3 || selection.Stream != 10 {
			t.Fatal("input binding was changed", selection)
		}
		result := state
		result.RequestID, result.RequestStream, result.InputEpoch = 1, 10, epoch
		result.Accepted, result.Result, result.Phase = true, "pending", "switching"
		return result, nil
	})
	body := `{"instance":"` + testDisplayInstance + `","display":"right","revision":12,"stream":10,"inputEpoch":3}`
	if response := fileCall(handler, first, "POST", "/v1/displays", body); response.Code != 409 || posts != 0 {
		t.Fatal("legacy engine received guarded request", response.Code, posts)
	}
	state.InputEpochSelection = true
	for _, raw := range []string{"0", "2", "-1", "4294967296", "1.5", "null", "false", `"3"`, "{}", "[]"} {
		invalid := strings.Replace(body, `"inputEpoch":3`, `"inputEpoch":`+raw, 1)
		if response := fileCall(handler, first, "POST", "/v1/displays", invalid); response.Code != 400 || posts != 0 {
			t.Fatal("invalid epoch forwarded", raw, response.Code, posts)
		}
	}
	state.Streams = displayFixture(first, second).Streams
	if response := fileCall(handler, first, "POST", "/v1/displays", body); response.Code != 409 || posts != 0 {
		t.Fatal("shared host accepted", response.Code, posts)
	}
	state.Streams = state.Streams[:1]
	if response := fileCall(handler, second, "POST", "/v1/displays", body); response.Code != 403 || posts != 0 {
		t.Fatal("unowned stream accepted", response.Code, posts)
	}
	response := fileCall(handler, first, "POST", "/v1/displays", body)
	if response.Code != 200 || posts != 1 || !strings.Contains(response.Body.String(), `"inputEpoch":3`) || !strings.Contains(response.Body.String(), `"requestStream":10`) {
		t.Fatal(response.Code, response.Body.String(), posts)
	}
}

func TestDisplayInputEpochForwardingPreservesLegacyAndExactGuard(t *testing.T) {
	state := displayFixture([]byte("first"), []byte("second"))
	state.InputEpochSelection = true
	requests := []map[string]json.RawMessage{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/cliprelay/displays" {
			t.Error("wrong endpoint", r.Method, r.URL.Path)
		}
		var value map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&value) != nil {
			t.Error("invalid request JSON")
		}
		requests = append(requests, value)
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer server.Close()
	selection := displaySelection{Instance: testDisplayInstance, Display: "right", Revision: 12, Stream: 10}
	for _, epoch := range []json.RawMessage{nil, json.RawMessage("4294967295")} {
		selection.InputEpoch = epoch
		if _, err := requestEngineDisplay(context.Background(), server.URL, "test-secret", server.Certificate().Raw, false, &selection); err != nil {
			t.Fatal(err)
		}
	}
	if len(requests) != 2 || len(requests[0]) != 3 || len(requests[1]) != 5 || string(requests[1]["inputEpoch"]) != "4294967295" || string(requests[1]["stream"]) != "10" {
		t.Fatal(requests)
	}
	selection.InputEpoch = json.RawMessage("null")
	if _, err := requestEngineDisplay(context.Background(), server.URL, "test-secret", server.Certificate().Raw, false, &selection); err == nil || len(requests) != 2 {
		t.Fatal("invalid epoch reached host")
	}
}

func TestDisplayInputEpochResultCannotContradictCapabilityOrBinding(t *testing.T) {
	state := displayFixture([]byte("first"), []byte("second"))
	for _, change := range []func(*displayState){
		func(s *displayState) { s.InputEpoch = 1 },
		func(s *displayState) { s.RequestStream = 10 },
		func(s *displayState) { s.InputEpoch = 1; s.RequestStream = 10; s.RequestID = 1; s.Result = "pending" },
		func(s *displayState) {
			s.InputEpochSelection = true
			s.InputEpoch = 2
			s.RequestStream = 10
			s.RequestID = 1
			s.Result = "pending"
		},
		func(s *displayState) {
			s.InputEpochSelection = true
			s.InputEpoch = 1
			s.RequestStream = 10
			s.Result = "pending"
		},
		func(s *displayState) {
			s.InputEpochSelection = true
			s.InputEpoch = 1
			s.RequestStream = 1 << 53
			s.RequestID = 1
			s.Result = "pending"
		},
	} {
		invalid := state
		change(&invalid)
		if validDisplayState(invalid) {
			t.Fatal("contradictory input selection accepted", invalid)
		}
	}
	state.InputEpochSelection, state.InputEpoch, state.RequestStream, state.RequestID, state.Result = true, 3, 10, 1, "pending"
	if !validDisplayState(state) {
		t.Fatal("valid input binding rejected")
	}
}

func TestDisplayInputEpochHostRejectionIsNotAccepted(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	first := []byte("first")
	filePairing(t, clients, first)
	state := displayFixture(first, []byte("second"))
	state.Streams = state.Streams[:1]
	state.InputEpochSelection = true
	posts := 0
	handler := withDisplays(http.NotFoundHandler(), clients, func(_ context.Context, _ bool, selection *displaySelection) (displayState, error) {
		result := state
		if selection != nil {
			posts++
			result.Outcome = "input_not_paused"
		}
		return result, nil
	})
	body := `{"instance":"` + testDisplayInstance + `","display":"right","revision":12,"stream":10,"inputEpoch":3}`
	response := fileCall(handler, first, "POST", "/v1/displays", body)
	if response.Code != 409 || posts != 1 || !strings.Contains(response.Body.String(), `"accepted":false`) {
		t.Fatal(response.Code, response.Body.String(), posts)
	}
}
