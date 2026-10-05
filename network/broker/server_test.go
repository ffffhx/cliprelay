package broker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeControl struct {
	users, keys      int
	nodes            []NetworkNode
	expired, deleted []string
}

func (f *fakeControl) CreateUser(context.Context, string) (string, error) {
	f.users++
	return fmt.Sprint(f.users), nil
}
func (f *fakeControl) Enroll(_ context.Context, _ string, t time.Time) (Enrollment, error) {
	f.keys++
	return Enrollment{ID: fmt.Sprint(f.keys), Key: fmt.Sprint("private-key-", f.keys), Expiration: t}, nil
}
func (f *fakeControl) Nodes(context.Context) ([]NetworkNode, error) { return f.nodes, nil }
func (f *fakeControl) DeleteNode(_ context.Context, id string) error {
	f.deleted = append(f.deleted, id)
	return nil
}
func (f *fakeControl) ExpireEnrollment(_ context.Context, id string) error {
	f.expired = append(f.expired, id)
	return nil
}

func credential(ch string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat(ch, 32)))
}
func call(t *testing.T, s *Server, method, path, token, body string, status int) map[string]any {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "203.0.113.1:1234"
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != status {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	var v map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func fixture(t *testing.T) (*Server, *fakeControl) {
	t.Helper()
	f := &fakeControl{}
	s, err := New(f, "https://control.invalid", filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s, f
}
func code(t *testing.T, s *Server, token string) string {
	return call(t, s, "POST", "/v1/codes", token, `{}`, 200)["value"].(string)
}
func claimPhone(t *testing.T, s *Server, host, phone string) string {
	v := call(t, s, "POST", "/v1/claims", phone, fmt.Sprintf(`{"name":"phone","code":%q}`, code(t, s, host)), 201)
	return v["id"].(string)
}

func TestPairingRequiresOwnerApprovalAndIsolatesComputers(t *testing.T) {
	s, f := fixture(t)
	host, phone, other := credential("h"), credential("p"), credential("x")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	call(t, s, "POST", "/v1/hosts", other, `{"name":"unrelated computer"}`, 201)
	id := claimPhone(t, s, host, phone)
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 403)
	if f.keys != 0 {
		t.Fatal("issued enrollment before confirmation")
	}
	call(t, s, "POST", "/v1/approve", other, fmt.Sprintf(`{"id":%q}`, id), 404)
	call(t, s, "POST", "/v1/codes", phone, `{}`, 403)
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 200)
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 200)
	if f.keys != 1 {
		t.Fatal("retry minted another credential")
	}
	v := call(t, s, "GET", "/v1/status", other, "", 200)
	if len(v["pending"].([]any)) != 0 || len(v["peers"].([]any)) != 0 {
		t.Fatal("leaked another computer's devices")
	}
	if strings.Contains(fmt.Sprint(v), "private-key-") {
		t.Fatal("status leaked enrollment secret")
	}
	if f.users != 2 {
		t.Fatal("computers share an accountless network identity")
	}
}

func TestCodeSingleUseExpiryAndRateLimit(t *testing.T) {
	s, _ := fixture(t)
	host := credential("h")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	c := code(t, s, host)
	call(t, s, "POST", "/v1/claims", credential("a"), fmt.Sprintf(`{"name":"phone","code":%q}`, c), 201)
	call(t, s, "POST", "/v1/claims", credential("b"), fmt.Sprintf(`{"name":"phone","code":%q}`, c), 404)
	c = code(t, s, host)
	now := s.now()
	s.now = func() time.Time { return now.Add(6 * time.Minute) }
	call(t, s, "POST", "/v1/claims", credential("c"), fmt.Sprintf(`{"name":"phone","code":%q}`, c), 404)
	for range 9 {
		call(t, s, "POST", "/v1/claims", credential("c"), `{"name":"phone","code":"00000000"}`, 404)
	}
	call(t, s, "POST", "/v1/claims", credential("c"), `{"name":"phone","code":"00000000"}`, 429)
}

func TestRevokeInvalidatesUnusedKeyAndExistingNode(t *testing.T) {
	s, f := fixture(t)
	host, phone := credential("h"), credential("p")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	id := claimPhone(t, s, host, phone)
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 200)
	n := NetworkNode{ID: "91", IPs: []string{"100.80.0.2"}, Online: true}
	n.User.ID = "1"
	n.PreAuthKey.ID = "1"
	f.nodes = []NetworkNode{n}
	call(t, s, "POST", "/v1/revoke", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	if len(f.expired) != 1 || f.expired[0] != "1" || len(f.deleted) != 1 || f.deleted[0] != "91" {
		t.Fatal("revocation left network credentials active")
	}
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 401)
	call(t, s, "GET", "/v1/status", phone, "", 401)
}

func TestPersistenceAndCredentialValidation(t *testing.T) {
	s, f := fixture(t)
	host := credential("h")
	call(t, s, "POST", "/v1/hosts", "short", `{"name":"computer"}`, 401)
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer","admin":true}`, 400)
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	restarted, err := New(f, s.controlURL, s.statePath)
	if err != nil {
		t.Fatal(err)
	}
	call(t, restarted, "POST", "/v1/hosts", host, `{"name":"computer"}`, 200)
	if f.users != 1 {
		t.Fatal("restart recreated identity")
	}
	call(t, restarted, "GET", "/v1/status", credential("z"), "", 401)
}

func TestApprovedOfflinePhoneRemainsRevocable(t *testing.T) {
	s, _ := fixture(t)
	host, phone := credential("h"), credential("p")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	id := claimPhone(t, s, host, phone)
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	peers := call(t, s, "GET", "/v1/status", host, "", 200)["peers"].([]any)
	if len(peers) != 1 || peers[0].(map[string]any)["id"] != id || peers[0].(map[string]any)["online"] != false {
		t.Fatal("approved phone disappeared before its first enrollment")
	}
	call(t, s, "POST", "/v1/revoke", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	call(t, s, "POST", "/v1/enroll", phone, `{}`, 401)
}

func TestExpiredNodeGetsFreshSingleUseEnrollment(t *testing.T) {
	s, f := fixture(t)
	host := credential("h")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	call(t, s, "POST", "/v1/enroll", host, `{}`, 200)
	n := NetworkNode{ID: "7", Expiry: s.now().Add(-time.Minute)}
	n.User.ID, n.PreAuthKey.ID = "1", "1"
	f.nodes = []NetworkNode{n}
	if call(t, s, "GET", "/v1/status", host, "", 200)["reauthorize"] != true {
		t.Fatal("missing renewal signal")
	}
	for range 2 {
		v := call(t, s, "POST", "/v1/enroll", host, `{}`, 200)
		if v["registered"] != false || v["authKey"] != "private-key-2" {
			t.Fatal("expired node reused consumed key")
		}
	}
	if f.keys != 2 {
		t.Fatal("renewal retry minted extra keys")
	}
}

func TestFailedClaimCommitDoesNotConsumePairingCode(t *testing.T) {
	s, _ := fixture(t)
	host, phone := credential("h"), credential("p")
	call(t, s, "POST", "/v1/hosts", host, `{"name":"computer"}`, 201)
	c := code(t, s, host)
	validPath := s.statePath
	// A regular file as the parent makes persistence fail even as administrator.
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	s.statePath = filepath.Join(blocker, "state.json")
	body := fmt.Sprintf(`{"name":"phone","code":%q}`, c)
	call(t, s, "POST", "/v1/claims", phone, body, 503)
	s.statePath = validPath
	call(t, s, "POST", "/v1/claims", phone, body, 201)
}
