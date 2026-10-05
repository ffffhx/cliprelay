package inputfocus

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	id, _ := verification(p.serverCert, []byte("phone certificate"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
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
	json.Unmarshal(w.Body.Bytes(), &result)
	if len(result) != 4 || result["id"] != id || result["pin"] != nil {
		t.Fatal("unexpected public pairing data", result)
	}
	onDisk, err := os.ReadFile(filepath.Join(p.dir, id+".json"))
	if err != nil || bytes.Contains(onDisk, []byte("4567")) {
		t.Fatal("PIN leaked into local UI record")
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
