package broker

import (
	"fmt"
	"testing"
	"time"
)

func TestDirectoryOptInLeaseAndIndependentCredentials(t *testing.T) {
	s, f := fixture(t)
	host, viewer := credential("h"), credential("v")
	hostID := call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)["id"].(string)
	list := func() []any { return call(t, s, "GET", "/v1/directory", viewer, "", 200)["devices"].([]any) }
	if len(list()) != 0 {
		t.Fatal("unpublished host visible")
	}
	claim := fmt.Sprintf(`{"id":%q,"name":"Viewer"}`, hostID)
	call(t, s, "POST", "/v1/directory/claim", viewer, claim, 404)
	publish := func(discover, connect bool) {
		call(t, s, "POST", "/v1/presence", host, fmt.Sprintf(`{"deviceId":"local-id","name":"PC","platform":"windows","discoverable":%t,"connectable":%t}`, discover, connect), 200)
	}
	publish(true, false)
	if len(list()) != 1 || list()[0].(map[string]any)["connectable"] != false {
		t.Fatal("missing non-connectable device")
	}
	call(t, s, "POST", "/v1/directory/claim", viewer, claim, 404)
	publish(true, true)
	id := call(t, s, "POST", "/v1/directory/claim", viewer, claim, 201)["id"]
	call(t, s, "POST", "/v1/directory/claim", viewer, claim, 200)
	call(t, s, "POST", "/v1/enroll", viewer, `{}`, 200)
	if f.keys != 1 {
		t.Fatal("missing per-viewer enrollment")
	}
	call(t, s, "POST", "/v1/presence", viewer, `{}`, 403)
	publish(false, true)
	if len(list()) != 0 {
		t.Fatal("hidden host still listed")
	}
	call(t, s, "POST", "/v1/directory/claim", credential("n"), claim, 404)
	call(t, s, "GET", "/v1/status", viewer, "", 200)
	publish(true, true)
	before := s.now()
	s.now = func() time.Time { return before.Add(16 * time.Second) }
	if len(list()) != 0 {
		t.Fatal("expired host remained visible")
	}
	call(t, s, "POST", "/v1/directory/claim", credential("n"), claim, 404)
	call(t, s, "POST", "/v1/revoke", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	call(t, s, "POST", "/v1/enroll", viewer, `{}`, 401)
	publish(true, true)
	call(t, s, "POST", "/v1/directory/claim", viewer, claim, 409)
}

func TestDirectoryRestartDropsPresenceAndDoesNotLeakPrivateFields(t *testing.T) {
	s, _ := fixture(t)
	host, viewer := credential("h"), credential("v")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)
	call(t, s, "POST", "/v1/presence", host, `{"deviceId":"local-id","name":"PC","platform":"windows","discoverable":true,"connectable":true}`, 200)
	d := call(t, s, "GET", "/v1/directory", viewer, "", 200)["devices"].([]any)[0].(map[string]any)
	if len(d) != 5 {
		t.Fatalf("unexpected public fields: %v", d)
	}
	if len(call(t, s, "GET", "/v1/directory", host, "", 200)["devices"].([]any)) != 0 {
		t.Fatal("self listed")
	}
	restarted, err := New(s.control, s.controlURL, s.statePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(call(t, restarted, "GET", "/v1/directory", viewer, "", 200)["devices"].([]any)) != 0 {
		t.Fatal("stale publication restored")
	}
}
