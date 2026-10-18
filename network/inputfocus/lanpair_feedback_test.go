package inputfocus

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func feedbackCall(p *lanPairer, certificate []byte, method, path, body, receipt string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-ClipRelay-Pairing-Feedback", "1")
	r.Header.Set("X-ClipRelay-Pairing-Receipt", receipt)
	r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: certificate}}}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w
}

func feedbackRequest(t *testing.T, p *lanPairer) (lanRequest, managedPairRequest) {
	t.Helper()
	w := feedbackCall(p, []byte("managed fixture client"), "POST", "/v1/pair", `{"name":"Fixture phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`, "")
	var public lanRequest
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &public) != nil || public.Feedback == nil || public.Feedback.Protocol != 1 || !pairNonce.MatchString(public.Feedback.Receipt) {
		t.Fatal("feedback capability missing")
	}
	list := managedCall(t, p, map[string]string{"op": "host-pair-list"})["requests"].([]managedPairRequest)
	if len(list) != 1 || public.Feedback.Receipt == list[0].Generation {
		t.Fatal("public receipt is not independent of private generation")
	}
	return public, list[0]
}

func feedbackBody(request lanRequest) string {
	return `{"id":"` + request.ID + `","receipt":"` + request.Feedback.Receipt + `"}`
}

func feedbackState(t *testing.T, p *lanPairer, request lanRequest) pairFeedbackStatus {
	t.Helper()
	w := feedbackCall(p, []byte("managed fixture client"), "POST", "/v1/pair/status", feedbackBody(request), "")
	var result pairFeedbackStatus
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Protocol != 1 || result.ID != request.ID || result.Receipt != request.Feedback.Receipt {
		t.Fatal("invalid feedback response", w.Code)
	}
	return result
}

func TestLANPairingFeedbackRequiresExplicitCapabilityAndCurrentReceipt(t *testing.T) {
	p := managedPairFixture(t)
	request, _ := feedbackRequest(t, p)
	if feedbackState(t, p, request).State != "waiting" {
		t.Fatal("new request is not waiting")
	}
	for _, receipt := range []string{"", strings.Repeat("0", 32)} {
		if w := feedbackCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+request.ID, "", receipt); w.Code != 404 {
			t.Fatal("unbound cancellation accepted")
		}
	}
	if w := feedbackCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+request.ID, "", request.Feedback.Receipt); w.Code != 204 {
		t.Fatal("owner cancellation refused")
	}
	waitManagedGone(t, p, request.ID)
	if feedbackState(t, p, request).State != "cancelled" {
		t.Fatal("cancelled outcome lost")
	}
	legacy := managedRequest(t, p) // No capability header: unchanged four fields.
	if w := lanCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+legacy.ID, ""); w.Code != 204 {
		t.Fatal("legacy cancellation changed")
	}
}

func TestLANPairingFeedbackRejectIsRetainedAcrossSameIDReplacement(t *testing.T) {
	p := managedPairFixture(t)
	first, local := feedbackRequest(t, p)
	managedCall(t, p, managedDecision(local, "host-pair-reject"))
	if feedbackState(t, p, first).State != "rejected" {
		t.Fatal("rejection unavailable before cleanup")
	}
	waitManagedGone(t, p, first.ID)
	second, _ := feedbackRequest(t, p)
	if first.ID != second.ID || first.Feedback.Receipt == second.Feedback.Receipt {
		t.Fatal("replacement did not renew receipt")
	}
	if feedbackState(t, p, first).State != "rejected" || feedbackState(t, p, second).State != "waiting" {
		t.Fatal("old and new decisions confused")
	}
	if w := feedbackCall(p, []byte("managed fixture client"), "DELETE", "/v1/pair/"+first.ID, "", first.Feedback.Receipt); w.Code != 404 {
		t.Fatal("stale caller cancelled replacement")
	}
	if feedbackState(t, p, second).State != "waiting" {
		t.Fatal("replacement changed after stale cancellation")
	}
}

func TestLANPairingFeedbackRejectsForeignCertificatesAndMalformedQueries(t *testing.T) {
	p := managedPairFixture(t)
	request, _ := feedbackRequest(t, p)
	for _, certificate := range [][]byte{[]byte("other client"), nil} {
		if w := feedbackCall(p, certificate, "POST", "/v1/pair/status", feedbackBody(request), ""); w.Code != 404 {
			t.Fatal("foreign client obtained a decision")
		}
	}
	for _, body := range []string{`{}`, `[]`, feedbackBody(request) + `{}`, strings.Replace(feedbackBody(request), `"receipt":`, `"extra":`, 1),
		`{"id":"` + request.ID + `","id":"` + request.ID + `","receipt":"` + request.Feedback.Receipt + `"}`, strings.Repeat("x", 2049)} {
		if w := feedbackCall(p, []byte("managed fixture client"), "POST", "/v1/pair/status", body, ""); w.Code != 400 {
			t.Fatal("malformed query accepted", w.Code)
		}
	}
	wrong := request
	wrong.ID = strings.Repeat("0", 32)
	if w := feedbackCall(p, []byte("managed fixture client"), "POST", "/v1/pair/status", feedbackBody(wrong), ""); w.Code != 404 {
		t.Fatal("receipt accepted with different request ID")
	}
}

func TestLANPairingFeedbackExpiryCancelsAndRetainsResult(t *testing.T) {
	p := managedPairFixture(t)
	request, local := feedbackRequest(t, p)
	p.mu.Lock()
	p.requests[request.ID].Expires = time.Now().Unix() - 1
	p.mu.Unlock()
	if feedbackState(t, p, request).State != "expired" {
		t.Fatal("expiry not reported")
	}
	waitManagedGone(t, p, request.ID)
	if feedbackState(t, p, request).State != "expired" || managedCall(t, p, managedDecision(local, "host-pair-approve"))["code"] != "HOST_PAIR_STALE" {
		t.Fatal("expired generation became approvable")
	}
}

func TestLANPairingFeedbackLostPINReplyDoesNotClaimTrustOrRepeatMutation(t *testing.T) {
	p := managedPairFixture(t)
	var writes atomic.Int32
	id, _ := verification(p.serverCert, []byte("managed fixture client"), strings.Repeat("a", 32))
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		if method == "GET" {
			return []byte(`{"pairings":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"ClipRelay-` + id + `"}]}`), nil
		}
		writes.Add(1)
		return nil, errors.New("reply lost after native write")
	}
	request, local := feedbackRequest(t, p)
	managedCall(t, p, managedDecision(local, "host-pair-approve"))
	waitManagedGone(t, p, request.ID)
	for i := 0; i < 3; i++ {
		if feedbackState(t, p, request).State != "handshake" {
			t.Fatal("unconfirmed native proof was misrepresented")
		}
	}
	if writes.Load() != 1 {
		t.Fatal("PIN mutation repeated")
	}
}

func TestLANPairingFeedbackRetentionIsBoundedAndClosedOwnerClearsIt(t *testing.T) {
	p := managedPairFixture(t)
	p.mu.Lock()
	for i := 0; i < 140; i++ {
		r := &lanRequest{ID: fmt.Sprintf("%032x", i), Feedback: &pairFeedbackTicket{1, fmt.Sprintf("%032x", i)}, finalState: "rejected", client: []byte("fixture")}
		p.retainFeedbackLocked(r, context.Canceled)
	}
	if len(p.feedback) != 128 {
		t.Fatal("retention is not bounded")
	}
	for key, value := range p.feedback {
		value.until = time.Now().Add(-time.Second)
		p.feedback[key] = value
	}
	p.pruneFeedbackLocked(time.Now())
	if len(p.feedback) != 0 {
		t.Fatal("expired history retained")
	}
	p.mu.Unlock()
	request, _ := feedbackRequest(t, p)
	p.close()
	if len(p.feedback) != 0 || len(p.requests) != 0 {
		t.Fatal("owner close retained decisions")
	}
	if w := feedbackCall(p, []byte("managed fixture client"), "POST", "/v1/pair/status", feedbackBody(request), ""); w.Code != 503 {
		t.Fatal("closed owner served feedback")
	}
}

func TestLANPairingFeedbackRealMutualTLSOwnsTheRetainedDecision(t *testing.T) {
	host, client, other := fileTestCertificate(t), fileTestCertificate(t), fileTestCertificate(t)
	p := newLANPairer(context.Background(), t.TempDir(), host)
	p.managed = true
	t.Cleanup(p.close)
	server := httptest.NewUnstartedServer(p)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{host}, ClientAuth: tls.RequireAnyClientCert, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	t.Cleanup(server.Close)
	call := func(identity tls.Certificate, path, body string) (int, []byte) {
		t.Helper()
		transport := &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{identity}, MinVersion: tls.VersionTLS12,
			InsecureSkipVerify: true, VerifyConnection: func(state tls.ConnectionState) error {
				if len(state.PeerCertificates) != 1 || !bytes.Equal(state.PeerCertificates[0].Raw, host.Certificate[0]) {
					return errors.New("changed fixture host")
				}
				return nil
			}}}
		defer transport.CloseIdleConnections()
		r, _ := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-ClipRelay-Pairing-Feedback", "1")
		response, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var data bytes.Buffer
		_, _ = data.ReadFrom(response.Body)
		return response.StatusCode, data.Bytes()
	}
	code, data := call(client, "/v1/pair", `{"name":"TLS fixture","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`)
	var request lanRequest
	if code != 200 || json.Unmarshal(data, &request) != nil || request.Feedback == nil {
		t.Fatal("TLS bootstrap failed")
	}
	local := managedCall(t, p, map[string]string{"op": "host-pair-list"})["requests"].([]managedPairRequest)[0]
	managedCall(t, p, managedDecision(local, "host-pair-reject"))
	waitManagedGone(t, p, request.ID)
	if code, _ := call(other, "/v1/pair/status", feedbackBody(request)); code != 404 {
		t.Fatal("different TLS identity obtained result")
	}
	code, data = call(client, "/v1/pair/status", feedbackBody(request))
	var status pairFeedbackStatus
	if code != 200 || json.Unmarshal(data, &status) != nil || status.State != "rejected" {
		t.Fatal("owned TLS rejection unavailable")
	}
}
