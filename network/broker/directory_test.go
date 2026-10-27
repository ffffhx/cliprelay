package broker

import (
	"fmt"
	"testing"
)

func TestPublicDirectoryCannotBypassDeviceCode(t *testing.T) {
	s, _ := fixture(t)
	host, viewer := credential("h"), credential("v")
	id := call(t, s, "POST", "/v1/hosts", host, `{"name":"PC"}`, 201)["id"]
	call(t, s, "POST", "/v1/presence", host, `{"deviceId":"local-id","name":"PC","platform":"windows","discoverable":true,"connectable":true}`, 200)
	if len(call(t, s, "GET", "/v1/directory", viewer, "", 200)["devices"].([]any)) != 0 {
		t.Fatal("published host leaked")
	}
	call(t, s, "POST", "/v1/directory/claim", viewer, fmt.Sprintf(`{"id":%q,"name":"Viewer"}`, id), 403)
	call(t, s, "POST", "/v1/enroll", viewer, `{}`, 401)
}
