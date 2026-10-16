package inputfocus

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func nativeBootstrap(p *lanPairer) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/v1/pair", strings.NewReader(`{"name":"Fixture phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-ClipRelay-Pairing-Feedback", "1")
	r.Header.Set("X-ClipRelay-Pairing-Native", "1")
	r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: []byte("managed fixture client")}}}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w
}

func nativeRequest(t *testing.T, p *lanPairer) (lanRequest, managedPairRequest) {
	t.Helper()
	w := nativeBootstrap(p)
	var request lanRequest
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &request) != nil || request.Native == nil || request.Feedback == nil ||
		request.Native.Protocol != 1 || !pairNonce.MatchString(request.Native.ID) {
		t.Fatal("native generation was not registered", w.Code)
	}
	list := managedCall(t, p, map[string]string{"op": "host-pair-list"})["requests"].([]managedPairRequest)
	if len(list) != 1 {
		t.Fatal("registered request missing from local UI")
	}
	for _, value := range []string{request.ID, request.Feedback.Receipt, list[0].Generation} {
		if request.Native.ID == value {
			t.Fatal("native generation reused another protocol identity")
		}
	}
	return request, list[0]
}

func TestLANPairingNativeTerminalDecisionsCleanTheExactGeneration(t *testing.T) {
	for _, reason := range []string{"reject", "expire", "client-cancel", "owner-close"} {
		t.Run(reason, func(t *testing.T) {
			p := managedPairFixture(t)
			registered := make(chan map[string]string, 1)
			deleted := make(chan map[string]string, 1)
			p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
				if path != "/api/cliprelay/pairing" {
					t.Error("unapproved request reached PIN API")
					return nil, errors.New("unexpected API")
				}
				if method == "POST" {
					registered <- body.(map[string]string)
				} else if method == "DELETE" {
					deleted <- body.(map[string]string)
				} else {
					t.Error("unexpected method")
				}
				return []byte(`{"protocol":1,"status":true}`), nil
			}
			request, local := nativeRequest(t, p)
			registration := <-registered
			if registration["id"] != request.Native.ID || registration["client_fingerprint"] != nativePairFingerprint(&lanRequest{client: []byte("managed fixture client")}) {
				t.Fatal("registration lost TLS certificate binding")
			}
			switch reason {
			case "reject":
				managedCall(t, p, managedDecision(local, "host-pair-reject"))
			case "expire":
				p.mu.Lock()
				p.requests[request.ID].Expires = time.Now().Unix() - 1
				p.mu.Unlock()
				if feedbackState(t, p, request).State != "expired" {
					t.Fatal("expiry not observable")
				}
			case "client-cancel":
				if reply := feedbackCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+request.ID, "", request.Feedback.Receipt); reply.Code != 204 {
					t.Fatal("cancel failed")
				}
			case "owner-close":
				p.close()
			}
			waitManagedGone(t, p, request.ID)
			select {
			case cleanup := <-deleted:
				if cleanup["id"] != registration["id"] || cleanup["client_fingerprint"] != registration["client_fingerprint"] {
					t.Fatal("cleanup targeted another generation")
				}
			default:
				t.Fatal("native cleanup was skipped")
			}
		})
	}
}

func TestLANPairingNativeApprovalUsesBoundFieldsInsteadOfDisplayName(t *testing.T) {
	p := managedPairFixture(t)
	var nativeID, fingerprint string
	submitted := make(chan string, 1)
	var cleanups atomic.Int32
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if path == "/api/cliprelay/pairing" {
			if method == "POST" {
				fields := body.(map[string]string)
				nativeID = fields["id"]
				fingerprint = fields["client_fingerprint"]
			} else {
				cleanups.Add(1)
			}
			return []byte(`{"protocol":1,"status":true}`), nil
		}
		if method == "GET" {
			return json.Marshal(map[string]any{"pairings": []map[string]string{
				{"id": strings.Repeat("a", 32), "name": "ClipRelay-" + nativeID, "managed_id": nativeID, "client_fingerprint": strings.Repeat("0", 64)},
				{"id": strings.Repeat("b", 32), "name": "ClipRelay-" + nativeID, "managed_id": strings.Repeat("0", 32), "client_fingerprint": fingerprint},
				{"id": strings.Repeat("c", 32), "name": "irrelevant display name", "managed_id": nativeID, "client_fingerprint": fingerprint},
			}})
		}
		submitted <- body.(map[string]string)["pairing_id"]
		return []byte(`{"status":true}`), nil
	}
	request, local := nativeRequest(t, p)
	managedCall(t, p, managedDecision(local, "host-pair-approve"))
	select {
	case id := <-submitted:
		if id != strings.Repeat("c", 32) {
			t.Fatal("approved an unbound native request")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native PIN was not submitted")
	}
	waitManagedGone(t, p, request.ID)
	if cleanups.Load() != 1 || feedbackState(t, p, request).State != "handshake" {
		t.Fatal("cleanup replaced certificate proof or was skipped")
	}
}

func TestLANPairingNativeLostRegistrationReplyIsCancelledWithoutReplay(t *testing.T) {
	p := managedPairFixture(t)
	var posts, deletes atomic.Int32
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if path != "/api/cliprelay/pairing" {
			t.Error("unexpected API")
		}
		if method == "POST" {
			posts.Add(1)
			return nil, errors.New("registration reply lost")
		}
		deletes.Add(1)
		return []byte(`{"protocol":1,"status":true}`), nil
	}
	if nativeBootstrap(p).Code != 503 {
		t.Fatal("unconfirmed registration was advertised")
	}
	p.close()
	if posts.Load() != 1 || deletes.Load() != 1 {
		t.Fatal("registration replayed or cleanup skipped")
	}
}

func TestLANPairingNativeCleanupIsBoundedAndJoined(t *testing.T) {
	p := managedPairFixture(t)
	var deletes atomic.Int32
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if method == "POST" {
			return []byte(`{"protocol":1,"status":true}`), nil
		}
		deletes.Add(1)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	nativeRequest(t, p)
	started := time.Now()
	done := make(chan struct{})
	go func() { p.close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup outlived owner deadline")
	}
	if time.Since(started) < nativePairOperationTimeout || deletes.Load() != 1 {
		t.Fatal("owner did not join exactly one bounded cleanup")
	}
}

func TestLANPairingNativeNonceReuseGetsFreshIdentityAfterCleanup(t *testing.T) {
	p := managedPairFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var deletions atomic.Int32
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if method == "DELETE" && deletions.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []byte(`{"protocol":1,"status":true}`), nil
	}
	first, local := nativeRequest(t, p)
	managedCall(t, p, managedDecision(local, "host-pair-reject"))
	<-entered
	if feedbackState(t, p, first).State != "rejected" {
		t.Fatal("cleanup delayed rejection feedback")
	}
	if nativeBootstrap(p).Code != 409 {
		t.Fatal("old generation was reused during cleanup")
	}
	close(release)
	waitManagedGone(t, p, first.ID)
	second, current := nativeRequest(t, p)
	if first.ID != second.ID || first.Native.ID == second.Native.ID {
		t.Fatal("nonce reuse revived a native generation")
	}
	if reply := feedbackCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+first.ID, "", first.Feedback.Receipt); reply.Code != 404 {
		t.Fatal("old receipt cancelled new generation")
	}
	if managedCall(t, p, managedDecision(local, "host-pair-reject"))["code"] != "HOST_PAIR_STALE" {
		t.Fatal("old UI cancelled new generation")
	}
	managedCall(t, p, managedDecision(current, "host-pair-reject"))
	waitManagedGone(t, p, second.ID)
}

func TestLANPairingNativeLocalStopClosesAdmissionsAndJoinsCleanup(t *testing.T) {
	p := managedPairFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if method == "DELETE" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []byte(`{"protocol":1,"status":true}`), nil
	}
	nativeRequest(t, p)
	if reply := managedCall(t, p, map[string]string{"op": "host-pair-stop", "id": strings.Repeat("0", 32)}); reply["ok"] != false {
		t.Fatal("malformed stop closed admissions")
	}
	done := make(chan any, 1)
	go func() { reply, _ := p.local([]byte(`{"op":"host-pair-stop"}`)); done <- reply }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("stop did not reach cleanup")
	}
	select {
	case <-done:
		t.Fatal("stop acknowledged before cleanup")
	default:
	}
	if nativeBootstrap(p).Code != 503 {
		t.Fatal("closed owner still admitted pairing")
	}
	close(release)
	select {
	case value := <-done:
		if value.(map[string]any)["ok"] != true {
			t.Fatal("stop did not acknowledge joined cleanup")
		}
	case <-time.After(time.Second):
		t.Fatal("stop failed to join completed cleanup")
	}
	if reply := managedCall(t, p, map[string]string{"op": "host-pair-list"}); reply["code"] != "HOST_PAIR_CLOSED" {
		t.Fatal("stopped pairer reopened")
	}
}
