package inputfocus

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutomationIdentityRevocationAndStrictBoundary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, path, []byte("first"), []byte("second"))
	calls := []map[string]any{}
	revoke := false
	control := &automationControl{clients: path, read: func(body string) (json.RawMessage, error) {
		var request map[string]any
		if err := json.Unmarshal([]byte(body), &request); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, request)
		if revoke && request["op"] != "sync" {
			filePairing(t, path, []byte("second"))
		}
		return json.Marshal(automationReply{OK: true, Instance: terminalTestInstance, Result: json.RawMessage(`{"windows":true}`)})
	}}
	handler := control.handler(http.NotFoundHandler())
	call := func(peer []byte, body string) int {
		return fileCall(handler, peer, "POST", "/v1/automation", body).Code
	}
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if call(peer, `{"op":"capabilities"}`) != 403 {
			t.Fatal("unpaired admitted")
		}
	}
	for _, body := range []string{`{"op":"sync","owners":[]}`, `{"op":"capabilities","owner":"first"}`, `{"op":"capabilities","params":{"command":"cmd"}}`, `{"op":"windows"}`, `{"op":"capabilities"}{}`, `{"op":"shell"}`} {
		if call([]byte("first"), body) != 400 {
			t.Fatal("invalid request admitted", body)
		}
	}
	if len(calls) != 0 {
		t.Fatal("invalid request reached worker")
	}
	if call([]byte("first"), `{"op":"capabilities"}`) != 200 {
		t.Fatal("valid capabilities failed")
	}
	if calls[1]["owner"] != displayOwner([]byte("first")) {
		t.Fatal("owner was not bound to TLS certificate")
	}
	request := `{"op":"window.action","instance":"` + terminalTestInstance + `","requestId":"` + strings.Repeat("a", 32) + `","session":"` + strings.Repeat("b", 32) + `","params":{"kind":"invoke","version":"v","ref":"e1"}}`
	if call([]byte("first"), request) != 200 {
		t.Fatal("valid typed action failed")
	}
	revoke = true
	if call([]byte("first"), request) != 403 {
		t.Fatal("revocation during operation released result")
	}
	if call([]byte("first"), `{"op":"capabilities"}`) != 403 {
		t.Fatal("revoked identity reused connection")
	}
}

func TestAutomationUnknownResultIsNotRetried(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	filePairing(t, path, []byte("first"))
	actions := 0
	control := &automationControl{clients: path, read: func(body string) (json.RawMessage, error) {
		if strings.Contains(body, `"op":"sync"`) {
			return json.Marshal(automationReply{OK: true, Instance: terminalTestInstance})
		}
		actions++
		return json.RawMessage(`{`), nil
	}}
	response := fileCall(control.handler(http.NotFoundHandler()), []byte("first"), "POST", "/v1/automation", `{"op":"capabilities"}`)
	if response.Code != 503 || actions != 1 || !strings.Contains(response.Body.String(), "AUTOMATION_OUTCOME_UNKNOWN") {
		t.Fatal(response.Code, actions, response.Body.String())
	}
}
