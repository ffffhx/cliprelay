package inputfocus

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func lanCall(p *lanPairer, cert []byte, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	if cert != nil {
		r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w
}

func TestLANPairingRequiresLocalApprovalAndBindsTheSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newLANPairer(ctx, t.TempDir(), tls.Certificate{Certificate: [][]byte{[]byte("host certificate")}})
	body := `{"name":"test phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"4567"}`
	if w := lanCall(p, nil, "POST", "/v1/pair", body); w.Code != 403 {
		t.Fatal("anonymous pairing accepted")
	}
	var calls atomic.Int32
	submitted := make(chan map[string]string, 1)
	id, code := verification(p.serverCert, []byte("phone certificate"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		calls.Add(1)
		if method == "GET" {
			return []byte(`{"pairings":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"another phone"},{"id":"cccccccccccccccccccccccccccccccc","name":"ClipRelay-` + id + `"}]}`), nil
		}
		submitted <- body.(map[string]string)
		return []byte(`{"status":true}`), nil
	}
	w := lanCall(p, []byte("phone certificate"), "POST", "/v1/pair", body)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{"id": id, "name": "test phone", "verification": code, "expires": result["expires"]}
	expires, ok := result["expires"].(float64)
	if !ok || expires <= float64(time.Now().Unix()) || expires > float64(time.Now().Add(2*time.Minute).Unix()) || !reflect.DeepEqual(result, expected) {
		t.Fatal("unexpected public pairing schema or values")
	}
	onDisk, err := os.ReadFile(filepath.Join(p.dir, id+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(onDisk, &record); err != nil || !reflect.DeepEqual(record, expected) {
		t.Fatal("local UI record contains unexpected fields or values")
	}
	if w := lanCall(p, []byte("different phone"), "DELETE", "/v1/pair/"+id, ""); w.Code != 404 {
		t.Fatal("another client cancelled pairing")
	}
	time.Sleep(500 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("engine pairing began without operator approval")
	}
	if err := os.WriteFile(filepath.Join(p.dir, id+".approved"), []byte("approved"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-submitted:
		if request["pairing_id"] != "cccccccccccccccccccccccccccccccc" || request["pin"] != "4567" || request["name"] != "test phone" {
			t.Fatal("wrong pairing authorized", request)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("approval not applied")
	}
}

func TestLANPairingPublicRecordExcludesSecretsDespiteCoincidentDigits(t *testing.T) {
	// A timestamp or user-supplied name may contain the PIN's digits. Check the
	// exact public schema, not a substring search over unrelated field values.
	request := lanRequest{ID: "public id", Name: "phone 4567", Verification: "1234-5678-9012", Expires: 1792145675,
		pin: "4567", client: []byte("private certificate"), generation: "private generation", decision: "waiting",
		cancel: func() {}, approval: make(chan bool), finalState: "private state"}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{"id": request.ID, "name": request.Name, "verification": request.Verification, "expires": float64(request.Expires)}
	if !reflect.DeepEqual(record, expected) {
		t.Fatal("public record contains unexpected fields or values")
	}
}

func TestLANPairingCancellationAndRequestValidation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newLANPairer(ctx, t.TempDir(), tls.Certificate{Certificate: [][]byte{[]byte("host")}})
	for _, body := range []string{`{}`, `{"name":"phone","nonce":"../escape","pin":"1234"}`, `{"name":"phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"0000"} {}`, strings.Repeat("x", 2100)} {
		if w := lanCall(p, []byte("phone"), "POST", "/v1/pair", body); w.Code != 400 {
			t.Fatal("invalid request accepted", w.Code)
		}
	}
	body := `{"name":"phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"0000"}`
	w := lanCall(p, []byte("phone"), "POST", "/v1/pair", body)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var request lanRequest
	json.Unmarshal(w.Body.Bytes(), &request)
	if w := lanCall(p, []byte("phone"), "POST", "/v1/pair", strings.Replace(body, "aaaa", "bbbb", 1)); w.Code != 409 {
		t.Fatal("duplicate pending identity accepted")
	}
	if w := lanCall(p, []byte("phone"), "DELETE", "/v1/pair/"+request.ID, ""); w.Code != 204 {
		t.Fatal("cannot cancel own request")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(p.dir, request.ID+".json")); os.IsNotExist(err) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("cancelled request retained")
}

func TestLANVerificationChangesWithEitherIdentityOrNonce(t *testing.T) {
	id, code := verification([]byte("host"), []byte("phone"), "nonce")
	if len(id) != 32 || len(code) != 14 {
		t.Fatal("invalid verification format")
	}
	for _, tuple := range [][3]string{{"other host", "phone", "nonce"}, {"host", "other phone", "nonce"}, {"host", "phone", "other nonce"}} {
		otherID, otherCode := verification([]byte(tuple[0]), []byte(tuple[1]), tuple[2])
		if id == otherID || code == otherCode {
			t.Fatal("verification is not identity bound")
		}
	}
}

func TestLANPairingCloseJoinsApprovalAndRemovesPrivateRequests(t *testing.T) {
	p := newLANPairer(context.Background(), t.TempDir(), tls.Certificate{Certificate: [][]byte{[]byte("fixture host")}})
	defer p.close()
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	p.engine = func(ctx context.Context, _, _ string, _ any) ([]byte, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		return nil, ctx.Err()
	}
	body := `{"name":"fixture phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`
	w := lanCall(p, []byte("fixture phone"), "POST", "/v1/pair", body)
	var request lanRequest
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &request) != nil {
		t.Fatal("pairing fixture not admitted")
	}
	if err := os.WriteFile(filepath.Join(p.dir, request.ID+".approved"), []byte("fixture approval"), 0600); err != nil {
		t.Fatal(err)
	}
	waitHostSignal(t, started, "pending approval")
	done := make(chan struct{})
	go func() { p.close(); close(done) }()
	waitHostSignal(t, cancelled, "approval cancellation")
	select {
	case <-done:
		t.Fatal("pairing owner returned before approval joined")
	default:
	}
	if w := lanCall(p, []byte("another phone"), "POST", "/v1/pair", body); w.Code != 503 {
		t.Fatal("closed owner created another pending request")
	}
	close(release)
	waitHostSignal(t, done, "pairing owner close")
	entries, err := os.ReadDir(p.dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("request or approval survived owner close", err)
	}
	if len(p.requests) != 0 {
		t.Fatal("memory request survived owner close")
	}
}
