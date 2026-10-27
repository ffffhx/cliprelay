package inputfocus

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeviceCodeGuardsLANPairingBeforeApproval(t *testing.T) {
	p := managedPairFixture(t)
	p.deviceAccess = func() (bool, string, error) { return true, "12345678", nil }
	body := `{"name":"PC","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`
	for _, trial := range []struct {
		code   string
		status int
		reason string
	}{{"", 403, "DEVICE_CODE_REQUIRED"}, {"87654321", 403, "DEVICE_CODE_INVALID"}, {"12345678", 200, ""}} {
		input := body
		if trial.code != "" {
			input = strings.TrimSuffix(body, "}") + `,"deviceCode":"` + trial.code + `"}`
		}
		w := lanCall(p, []byte("new viewer"), "POST", "/v1/pair", input)
		if w.Code != trial.status || !strings.Contains(w.Body.String(), trial.reason) {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
	}
	if len(p.requests) != 1 {
		t.Fatal("missing/wrong code created a pairing request")
	}
}

func TestDeviceCodeRotationRejectsOldAdmissionsAndKeepsTrustedClients(t *testing.T) {
	p := managedPairFixture(t)
	file := filepath.Join(t.TempDir(), "service.json")
	setPolicy := func(code string, updating bool) {
		t.Helper()
		text := `{"requireDeviceCode":true,"deviceCode":"` + code + `","deviceCodeUpdating":`
		if updating {
			text += "true}"
		} else {
			text += "false}"
		}
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	setPolicy("12345678", false)
	p.deviceAccess = deviceAccessFile(file)
	filePairing(t, filepath.Join(filepath.Dir(p.dir), "clients.json"), []byte("trusted"))
	body := `{"name":"PC","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`
	withCode := func(code string) string { return strings.TrimSuffix(body, "}") + `,"deviceCode":"` + code + `"}` }
	if w := lanCall(p, []byte("new"), "POST", "/v1/pair", withCode("12345678")); w.Code != 200 {
		t.Fatal(w.Code)
	}
	requests := managedCall(t, p, map[string]string{"op": "host-pair-list"})["requests"].([]managedPairRequest)
	setPolicy("12345678", true)
	if w := lanCall(p, []byte("another"), "POST", "/v1/pair", withCode("12345678")); w.Code != 503 {
		t.Fatal("admitted during uncertain rotation", w.Code)
	}
	if w := lanCall(p, []byte("trusted"), "POST", "/v1/pair", body); w.Code != 200 {
		t.Fatal("trusted client blocked during rotation", w.Code)
	}
	setPolicy("87654321", false)
	if managedCall(t, p, managedDecision(requests[0], "host-pair-approve"))["ok"] == true {
		t.Fatal("old pending request approved")
	}
	if w := lanCall(p, []byte("another"), "POST", "/v1/pair", withCode("12345678")); w.Code != 403 {
		t.Fatal("old code accepted", w.Code)
	}
	if w := lanCall(p, []byte("another"), "POST", "/v1/pair", withCode("87654321")); w.Code != 200 {
		t.Fatal("new code rejected", w.Code)
	}
}

func TestDeviceCodeHonorsExistingPairingAndBoundsGuesses(t *testing.T) {
	p := managedPairFixture(t)
	p.deviceAccess = func() (bool, string, error) { return true, "12345678", nil }
	filePairing(t, filepath.Join(filepath.Dir(p.dir), "clients.json"), []byte("trusted"))
	body := `{"name":"PC","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`
	if w := lanCall(p, []byte("trusted"), "POST", "/v1/pair", body); w.Code != 200 {
		t.Fatalf("trusted viewer asked again: %d", w.Code)
	}
	wrong := strings.TrimSuffix(body, "}") + `,"deviceCode":"00000000"}`
	for i := 0; i < 6; i++ {
		if w := lanCall(p, []byte("guess"), "POST", "/v1/pair", wrong); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	if w := lanCall(p, []byte("another certificate"), "POST", "/v1/pair", wrong); w.Code != 429 {
		t.Fatal("certificate rotation bypassed rate limit")
	}
	p.deviceAccess = func() (bool, string, error) { return false, "", errors.New("unreadable") }
	if w := lanCall(p, []byte("new"), "POST", "/v1/pair", body); w.Code != 503 {
		t.Fatal("policy read failure allowed pairing")
	}
}

func TestEnablingDeviceCodeRejectsAlreadyPendingUnverifiedRequest(t *testing.T) {
	p := managedPairFixture(t)
	request := managedRequest(t, p)
	p.deviceAccess = func() (bool, string, error) { return true, "12345678", nil }
	if reply := managedCall(t, p, managedDecision(request, "host-pair-approve")); reply["ok"] == true {
		t.Fatal("pending request bypassed new code policy")
	}
}
