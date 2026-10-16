package inputfocus

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func managedPairFixture(t *testing.T) *lanPairer {
	t.Helper()
	p := newLANPairer(context.Background(), t.TempDir(), tls.Certificate{Certificate: [][]byte{[]byte("managed fixture host")}})
	p.managed = true
	t.Cleanup(p.close)
	return p
}

func managedRequest(t *testing.T, p *lanPairer) managedPairRequest {
	t.Helper()
	w := lanCall(p, []byte("managed fixture client"), "POST", "/v1/pair", `{"name":"Fixture phone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pin":"1234"}`)
	if w.Code != 200 {
		t.Fatal("request not admitted", w.Code)
	}
	var public map[string]any
	if json.Unmarshal(w.Body.Bytes(), &public) != nil || len(public) != 4 || public["generation"] != nil || public["pin"] != nil {
		t.Fatal("private fields exposed to remote caller")
	}
	list := managedCall(t, p, map[string]string{"op": "host-pair-list"})
	requests := list["requests"].([]managedPairRequest)
	if len(requests) != 1 || !pairNonce.MatchString(requests[0].Generation) || requests[0].State != "waiting" {
		t.Fatal("invalid pending request snapshot")
	}
	return requests[0]
}

func managedCall(t *testing.T, p *lanPairer, fields map[string]string) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(fields)
	value, handled := p.local(raw)
	if !handled {
		t.Fatal("managed command not dispatched")
	}
	return value.(map[string]any)
}

func managedDecision(request managedPairRequest, op string) map[string]string {
	return map[string]string{"op": op, "id": request.ID, "generation": request.Generation, "verification": request.Verification}
}

func waitManagedGone(t *testing.T, p *lanPairer, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		pending := p.requests[id] != nil
		p.mu.Unlock()
		if !pending {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("managed pairing did not join")
}

func TestLANPairingManagedLiveApprovalIgnoresLegacyFiles(t *testing.T) {
	p := managedPairFixture(t)
	var calls atomic.Int32
	submitted := make(chan map[string]string, 1)
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		calls.Add(1)
		if method == "GET" {
			id, _ := verification(p.serverCert, []byte("managed fixture client"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
			return []byte(`{"pairings":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"ClipRelay-` + id + `"}]}`), nil
		}
		submitted <- body.(map[string]string)
		return []byte(`{"status":true}`), nil
	}
	r := managedRequest(t, p)
	if _, err := os.Stat(p.dir); !os.IsNotExist(err) {
		t.Fatal("managed request created persistent approval state")
	}
	if err := os.Mkdir(p.dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, extension := range []string{".json", ".approved"} {
		if err := os.WriteFile(filepath.Join(p.dir, r.ID+extension), []byte("stale fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(450 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("legacy marker authorized managed request")
	}
	if reply := managedCall(t, p, managedDecision(r, "host-pair-approve")); reply["ok"] != true {
		t.Fatal(reply)
	}
	select {
	case got := <-submitted:
		if got["pin"] != "1234" || got["pairing_id"] != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
			t.Fatal("wrong native handshake approved")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("approved request not submitted")
	}
	waitManagedGone(t, p, r.ID)
	for _, extension := range []string{".json", ".approved"} {
		data, err := os.ReadFile(filepath.Join(p.dir, r.ID+extension))
		if err != nil || string(data) != "stale fixture" {
			t.Fatal("managed owner modified legacy files")
		}
	}
}

func TestLANPairingManagedRejectAndReusedNonceRequireFreshGeneration(t *testing.T) {
	p := managedPairFixture(t)
	var calls atomic.Int32
	p.engine = func(context.Context, string, string, any) ([]byte, error) { calls.Add(1); return []byte(`{}`), nil }
	first := managedRequest(t, p)
	if reply := managedCall(t, p, managedDecision(first, "host-pair-reject")); reply["ok"] != true {
		t.Fatal(reply)
	}
	waitManagedGone(t, p, first.ID)
	second := managedRequest(t, p)
	if second.ID != first.ID || second.Generation == first.Generation {
		t.Fatal("nonce reuse did not renew approval generation")
	}
	for _, op := range []string{"host-pair-approve", "host-pair-reject"} {
		if reply := managedCall(t, p, managedDecision(first, op)); reply["code"] != "HOST_PAIR_STALE" {
			t.Fatal(reply)
		}
	}
	wrong := second
	wrong.Verification = "FFFF FFFF FFFF"
	if reply := managedCall(t, p, managedDecision(wrong, "host-pair-approve")); reply["code"] != "HOST_PAIR_STALE" {
		t.Fatal(reply)
	}
	if reply := managedCall(t, p, managedDecision(second, "host-pair-reject")); reply["ok"] != true {
		t.Fatal(reply)
	}
	waitManagedGone(t, p, second.ID)
	if calls.Load() != 0 {
		t.Fatal("rejected or stale request reached engine")
	}
}

func TestLANPairingManagedDecisionIsAtomicAndExpires(t *testing.T) {
	p := managedPairFixture(t)
	p.engine = func(ctx context.Context, _, _ string, _ any) ([]byte, error) { <-ctx.Done(); return nil, ctx.Err() }
	r := managedRequest(t, p)
	var accepted atomic.Int32
	var pending sync.WaitGroup
	for i := 0; i < 16; i++ {
		pending.Add(1)
		go func(index int) {
			defer pending.Done()
			op := "host-pair-approve"
			if index%2 == 0 {
				op = "host-pair-reject"
			}
			raw, _ := json.Marshal(managedDecision(r, op))
			value, _ := p.local(raw)
			if value.(map[string]any)["ok"] == true {
				accepted.Add(1)
			}
		}(i)
	}
	pending.Wait()
	if accepted.Load() != 1 {
		t.Fatal("multiple decisions applied to one generation")
	}
	p.close()
	if reply := managedCall(t, p, map[string]string{"op": "host-pair-list"}); reply["code"] != "HOST_PAIR_CLOSED" {
		t.Fatal(reply)
	}
	p = managedPairFixture(t)
	r = managedRequest(t, p)
	p.mu.Lock()
	p.requests[r.ID].Expires = time.Now().Unix() - 1
	p.mu.Unlock()
	if reply := managedCall(t, p, managedDecision(r, "host-pair-approve")); reply["code"] != "HOST_PAIR_STALE" {
		t.Fatal(reply)
	}
	if got := managedCall(t, p, map[string]string{"op": "host-pair-list"})["requests"].([]managedPairRequest); len(got) != 0 {
		t.Fatal("expired request exposed")
	}
}

func TestLANPairingManagedCommandValidationAndLegacyIsolation(t *testing.T) {
	p := managedPairFixture(t)
	for _, raw := range []string{`{"op":"host-pair-list","op":"host-pair-list"}`, `{"op":"host-pair-list","id":"x"}`,
		`{"op":"host-pair-list","path":"/arbitrary"}`, `{"op":"host-pair-approve"}`, `{"op":"host-pair-list","generation":{}}`} {
		value, handled := p.local([]byte(raw))
		if !handled || value.(map[string]any)["code"] != "HOST_PAIR_INVALID" {
			t.Fatal("invalid private command accepted")
		}
	}
	p.managed = false
	if _, handled := p.local([]byte(`{"op":"host-pair-list"}`)); handled {
		t.Fatal("legacy Windows service acquired managed approval route")
	}
}

func TestLANPairingManagedPrivateSocketDispatchAndJoinedShutdown(t *testing.T) {
	p := managedPairFixture(t)
	request := managedRequest(t, p)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mailbox := newRelayMailbox(filepath.Join(t.TempDir(), "unused-clients.json"))
	done := make(chan struct{})
	go func() { defer close(done); _ = mailbox.serveLocal(ctx, listener, p.local) }()
	defer func() { cancel(); <-done }()
	connection, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
	_ = json.NewEncoder(connection).Encode(managedDecision(request, "host-pair-reject"))
	var reply map[string]any
	if json.NewDecoder(bufio.NewReader(connection)).Decode(&reply) != nil || reply["ok"] != true {
		t.Fatal("private socket decision failed")
	}
	waitManagedGone(t, p, request.ID)
}
