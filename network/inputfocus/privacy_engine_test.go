package inputfocus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func privacyEngineFixture() privacyEngineState {
	return privacyEngineState{Protocol: 1, privacyBinding: privacyBinding{Instance: testDisplayInstance}, Supported: true, Epoch: 1, Outcome: "status"}
}

func TestPrivacyEngineUsesPinnedPrivateTransport(t *testing.T) {
	var calls atomic.Int32
	password := strings.Repeat("fixture-secret-", 2)
	f := newManagedPrivacyFixture(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		user, secret, ok := r.BasicAuth()
		if !ok || user != "cliprelay" || secret != password || r.URL.Path != "/api/cliprelay/privacy" || r.URL.RawQuery != "" {
			t.Error("unexpected private request")
		}
		if r.Method == "POST" {
			if r.Header.Get("Content-Type") != "application/json" {
				t.Error("missing JSON type")
			}
			var request privacyEngineRequest
			raw, _ := io.ReadAll(r.Body)
			if decodePrivacyJSON(raw, &request, 4096) != nil || !validPrivacyBinding(request.privacyBinding) || request.Op != "prepare" || !validPrivacyIdentity(request.Worker) {
				t.Error("invalid private identity request")
			}
		}
		_ = json.NewEncoder(w).Encode(privacyEngineFixture())
	}))
	defer server.Close()
	request := &privacyEngineRequest{Op: "prepare", privacyBinding: privacyBinding{testDisplayInstance, strings.Repeat("a", 64), 10, privacyTestLease}}
	_, _ = f.broker.create()
	request.Worker = &f.worker.identity
	for _, q := range []*privacyEngineRequest{nil, request} {
		if _, err := requestEnginePrivacy(context.Background(), server.URL, password, server.Certificate().Raw, q); err != nil {
			t.Fatal(err)
		}
	}
	wrong := append([]byte(nil), server.Certificate().Raw...)
	wrong[0] ^= 1
	if _, err := requestEnginePrivacy(context.Background(), server.URL, password, wrong, nil); err == nil || calls.Load() != 2 {
		t.Fatal("credentials reached unpinned listener", err, calls.Load())
	}
}

func TestPrivacyEngineRejectsInvalidStateAndDuplicateKeys(t *testing.T) {
	baseline := privacyEngineFixture()
	raw, _ := json.Marshal(baseline)
	responses := [][]byte{append([]byte(`{"ready":true,`), raw[1:]...), []byte(`null`), []byte(`[]`), append(append([]byte(nil), raw...), raw...), []byte(strings.Repeat(" ", 8193))}
	for _, change := range []func(*privacyEngineState){
		func(s *privacyEngineState) { s.Epoch = 0 }, func(s *privacyEngineState) { s.Ready = true }, func(s *privacyEngineState) { s.FirstFrame = 1 },
		func(s *privacyEngineState) { s.ExpiresMs = 15001 }, func(s *privacyEngineState) { s.Owner = strings.Repeat("a", 64) }, func(s *privacyEngineState) { s.Outcome = "activate" },
	} {
		value := baseline
		change(&value)
		b, _ := json.Marshal(value)
		responses = append(responses, b)
	}
	for _, value := range responses {
		var state privacyEngineState
		if decodePrivacyJSON(value, &state, 8192) == nil && validPrivacyEngineState(state) {
			t.Fatalf("malformed state accepted: %.200s", value)
		}
	}
	var worker map[string]any
	for _, payload := range []string{`{"identity":{"pid":2,"pid":3}}`, `{"identity":{"pid":2,"PID":3}}`, `{"op":"status","Op":"prepare"}`, `{"leaſe":"alias"}`} {
		if decodePrivacyJSON([]byte(payload), &worker, 8192) == nil {
			t.Fatal("duplicate or aliased protocol key accepted")
		}
	}
	valid := privacyEngineState{Protocol: 1, privacyBinding: privacyBinding{testDisplayInstance, strings.Repeat("a", 64), 10, privacyTestLease}, Supported: true, Retained: true, Authorized: true, Ready: true, Epoch: 2, Generation: 3, FirstFrame: 4, ExpiresMs: 15000, Outcome: "status"}
	if !validPrivacyEngineState(valid) {
		t.Fatal("valid readiness refused")
	}
	for _, change := range []func(*privacyEngineState){func(s *privacyEngineState) { s.Authorized = false }, func(s *privacyEngineState) { s.Generation = 0 }, func(s *privacyEngineState) { s.Supported = false }, func(s *privacyEngineState) { s.Reason = "expired" }, func(s *privacyEngineState) { s.Stream = 1 << 53 }} {
		value := valid
		change(&value)
		if validPrivacyEngineState(value) {
			t.Fatal("inconsistent readiness admitted", value)
		}
	}
}

func TestPrivacyEngineInvalidBindingsNeverReachServer(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer server.Close()
	valid := privacyEngineRequest{Op: "status", privacyBinding: privacyBinding{testDisplayInstance, strings.Repeat("a", 64), 10, privacyTestLease}}
	for _, change := range []func(*privacyEngineRequest){func(q *privacyEngineRequest) { q.Op = "activate" }, func(q *privacyEngineRequest) { q.Owner = "foreign" }, func(q *privacyEngineRequest) { q.Stream = 1 << 53 }, func(q *privacyEngineRequest) { q.Op = "prepare" }, func(q *privacyEngineRequest) { q.Instance = "invalid" }} {
		value := valid
		change(&value)
		if _, err := requestEnginePrivacy(context.Background(), server.URL, strings.Repeat("secret", 4), server.Certificate().Raw, &value); err == nil {
			t.Fatal("invalid request forwarded")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("private malformed identity reached engine")
	}
}
