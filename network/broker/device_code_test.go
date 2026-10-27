package broker

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDeviceCodePersistsAndPairsMultipleDevicesWithoutEnumeration(t *testing.T) {
	s, control := fixture(t)
	host := credential("h")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)
	value := call(t, s, "POST", "/v1/device-code", host, `{}`, 200)["value"].(string)
	if len(value) != 8 {
		t.Fatal("invalid code")
	}
	reopened, err := New(control, s.controlURL, s.statePath)
	if err != nil {
		t.Fatal(err)
	}
	s = reopened
	if call(t, s, "POST", "/v1/device-code", host, `{}`, 200)["value"] != value {
		t.Fatal("code changed after restart")
	}
	for _, c := range []string{"a", "b"} {
		client := credential(c)
		result := call(t, s, "POST", "/v1/claims", client, fmt.Sprintf(`{"name":"Viewer","code":%q}`, value), 201)
		call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, result["id"]), 200)
		call(t, s, "POST", "/v1/enroll", client, `{}`, 200)
	}
	call(t, s, "POST", "/v1/device-code", credential("a"), `{}`, 403)
	if len(call(t, s, "GET", "/v1/directory", credential("x"), ``, 200)["devices"].([]any)) != 0 {
		t.Fatal("public enumeration enabled")
	}
	call(t, s, "POST", "/v1/directory/claim", credential("x"), `{"id":"aaaaaaaaaaaaaaaaaaaaaaaa","name":"Bypass"}`, 403)
	call(t, s, "POST", "/v1/claims", credential("z"), `{"name":"Wrong","code":"incorrect"}`, 400)
}

func TestDeviceCodeRotationInvalidatesOldCodeAndPreservesPairedDevices(t *testing.T) {
	s, control := fixture(t)
	host, trusted, pending := credential("h"), credential("t"), credential("p")
	hostID := call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)["id"].(string)
	previous := call(t, s, "POST", "/v1/device-code", host, `{}`, 200)["value"].(string)
	claim := func(client, value string) map[string]any {
		return call(t, s, "POST", "/v1/claims", client, fmt.Sprintf(`{"name":"Viewer","code":%q}`, value), 201)
	}
	id := claim(trusted, previous)["id"]
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	enrollment := call(t, s, "POST", "/v1/enroll", trusted, `{}`, 200)
	pendingID := claim(pending, previous)["id"]
	before := call(t, s, "GET", "/v1/status", trusted, "", 200)
	body := fmt.Sprintf(`{"previous":%q}`, previous)
	call(t, s, "POST", "/v1/device-code/rotate", trusted, body, 403)
	next := call(t, s, "POST", "/v1/device-code/rotate", host, body, 200)["value"].(string)
	if next == previous || !fixedCode.MatchString(next) {
		t.Fatal("device code did not change")
	}
	call(t, s, "POST", "/v1/claims", credential("o"), fmt.Sprintf(`{"name":"Old code","code":%q}`, previous), 404)
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, pendingID), 409)
	call(t, s, "POST", "/v1/enroll", pending, `{}`, 401)
	if !reflect.DeepEqual(before, call(t, s, "GET", "/v1/status", trusted, "", 200)) ||
		!reflect.DeepEqual(enrollment, call(t, s, "POST", "/v1/enroll", trusted, `{}`, 200)) || len(control.expired) != 0 || len(control.deleted) != 0 {
		t.Fatal("rotation changed an existing pairing or network enrollment")
	}
	claim(credential("n"), next)
	restarted, err := New(control, s.controlURL, s.statePath)
	if err != nil {
		t.Fatal(err)
	}
	// A response lost before the local save must not rotate a second time.
	if call(t, restarted, "POST", "/v1/device-code/rotate", host, body, 200)["value"] != next ||
		restarted.db.DeviceCodes[hostID] != next || !restarted.db.RetiredCodes[codeHash(previous)] {
		t.Fatal("rotation was not durable and idempotent")
	}
}

func TestDeviceCodeRotationFailedCommitPreservesCodeAndPendingRequests(t *testing.T) {
	s, _ := fixture(t)
	host := credential("h")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)
	previous := call(t, s, "POST", "/v1/device-code", host, `{}`, 200)["value"].(string)
	id := call(t, s, "POST", "/v1/claims", credential("p"), fmt.Sprintf(`{"name":"Pending","code":%q}`, previous), 201)["id"]
	validPath := s.statePath
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	s.statePath = filepath.Join(blocker, "state.json")
	call(t, s, "POST", "/v1/device-code/rotate", host, fmt.Sprintf(`{"previous":%q}`, previous), 503)
	s.statePath = validPath
	if call(t, s, "POST", "/v1/device-code", host, `{}`, 200)["value"] != previous || s.db.RetiredCodes[codeHash(previous)] {
		t.Fatal("failed save invalidated old code")
	}
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
}
