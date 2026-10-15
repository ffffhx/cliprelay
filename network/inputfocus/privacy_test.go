package inputfocus

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const privacyTestLease = "1234567890abcdef1234567890abcdef"

func privacyBody(op string) string {
	b, _ := json.Marshal(privacyRequest{op, testDisplayInstance, 10, privacyTestLease})
	return string(b)
}

type privacyFixture struct {
	control       *privacyControl
	state         displayState
	active        string
	starts, stops int
	now           time.Time
	fail          bool
}

func newPrivacyFixture(t *testing.T) (*privacyFixture, http.Handler) {
	t.Helper()
	f := &privacyFixture{now: time.Now(), state: displayFixture([]byte("first"), []byte("second"))}
	f.state.Streams = f.state.Streams[:1]
	f.control = &privacyControl{clients: filepath.Join(t.TempDir(), "clients.json"), now: func() time.Time { return f.now },
		provider: func(context.Context, bool, *displaySelection) (displayState, error) { return f.state, nil },
		read: func(command string) (json.RawMessage, error) {
			var q struct{ Op, Lease string }
			if !strings.HasPrefix(command, "privacy:") || json.Unmarshal([]byte(command[8:]), &q) != nil {
				t.Fatal("worker command")
				return nil, nil
			}
			switch q.Op {
			case "start":
				f.starts++
				f.active = q.Lease
			case "renew":
				if f.active != q.Lease {
					return json.RawMessage(`{"ok":false,"code":"PRIVACY_EXPIRED"}`), nil
				}
			case "stop":
				f.stops++
				f.active = ""
			}
			if f.fail && q.Op == "start" {
				return nil, errors.New("lost ack")
			}
			expires := int64(0)
			if f.active != "" {
				expires = 15000
			}
			b, e := json.Marshal(privacyResponse{OK: true, Supported: true, Active: f.active != "", Lease: f.active, ExpiresMs: expires})
			return b, e
		}}
	filePairing(t, f.control.clients, []byte("first"), []byte("second"))
	return f, f.control.handler(http.NotFoundHandler())
}
func TestPrivacyRequiresSoleCurrentPairedStream(t *testing.T) {
	f, h := newPrivacyFixture(t)
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if fileCall(h, peer, "POST", "/v1/privacy", privacyBody("start")).Code != 403 {
			t.Fatal("unpaired")
		}
	}
	for _, bad := range []string{`{"op":"start"}`, strings.Replace(privacyBody("start"), `"op":"start"`, `"op":"start","owner":"spoof"`, 1), privacyBody("start") + "{}"} {
		if fileCall(h, []byte("first"), "POST", "/v1/privacy", bad).Code != 400 {
			t.Fatal("bad request", bad)
		}
	}
	if fileCall(h, []byte("second"), "POST", "/v1/privacy", privacyBody("start")).Code != 409 {
		t.Fatal("foreign stream")
	}
	saved := f.state
	for _, kind := range []string{"instance", "shared", "switching", "unpresented", "generation"} {
		f.state = displayFixture([]byte("first"), []byte("second"))
		f.state.Streams = f.state.Streams[:1]
		switch kind {
		case "instance":
			f.state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
		case "shared":
			f.state.Streams = append(f.state.Streams, displayStream{Owner: displayOwner([]byte("second")), ID: 11, Generation: 2, Width: 1280, Height: 720, FirstFrame: 10})
		case "switching":
			f.state.Phase = "switching"
		case "unpresented":
			f.state.Streams[0].FirstFrame = 0
		case "generation":
			f.state.Streams[0].Generation++
		}
		if fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")).Code != 409 {
			t.Fatal(kind)
		}
	}
	f.state = saved
	if f.starts != 0 {
		t.Fatal("invalid requests changed screen")
	}
	if w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")); w.Code != 200 || f.starts != 1 || f.active == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := fileCall(h, []byte("second"), "POST", "/v1/privacy", `{"op":"status"}`); strings.Contains(w.Body.String(), privacyTestLease) || strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatal("lease leaked")
	}
	if fileCall(h, []byte("second"), "POST", "/v1/privacy", privacyBody("stop")).Code != 409 || f.active == "" {
		t.Fatal("foreign stop")
	}
}
func TestPrivacyRenewStopAndLocalEscape(t *testing.T) {
	f, h := newPrivacyFixture(t)
	call := func(op string) int { return fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody(op)).Code }
	if call("start") != 200 {
		t.Fatal("start")
	}
	f.now = f.now.Add(10 * time.Second)
	if call("renew") != 200 || f.starts != 1 {
		t.Fatal("renew starts a new mask")
	}
	f.now = f.now.Add(10 * time.Second)
	f.control.check(context.Background())
	if f.active == "" {
		t.Fatal("renew ignored")
	}
	f.active = "" // Actual local escape, worker expiry or worker restart.
	if call("renew") != 409 || f.starts != 1 || f.control.request.Lease != "" {
		t.Fatal("escape automatically undone")
	}
	if call("start") != 200 || call("stop") != 200 || f.active != "" {
		t.Fatal("explicit restart/stop")
	}
	if call("renew") != 409 {
		t.Fatal("stopped lease renewed")
	}
}
func TestPrivacyRecoveryWithoutFurtherClientRequests(t *testing.T) {
	for _, cause := range []string{"expiry", "revocation", "disconnect", "shared", "engine-restart", "unknown-engine"} {
		t.Run(cause, func(t *testing.T) {
			f, h := newPrivacyFixture(t)
			if fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")).Code != 200 {
				t.Fatal("start")
			}
			switch cause {
			case "expiry":
				f.now = f.now.Add(15 * time.Second)
			case "revocation":
				filePairing(t, f.control.clients, []byte("second"))
			case "disconnect":
				f.state.Streams = nil
				f.state.Phase = "idle"
			case "shared":
				f.state = displayFixture([]byte("first"), []byte("second"))
			case "engine-restart":
				f.state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
			case "unknown-engine":
				f.control.provider = func(context.Context, bool, *displaySelection) (displayState, error) {
					return displayState{}, errors.New("offline")
				}
			}
			f.control.check(context.Background())
			if f.active != "" || f.stops != 1 || f.control.request.Lease != "" {
				t.Fatal("not restored")
			}
		})
	}
}
func TestPrivacyLostAcknowledgmentAndShutdownRestore(t *testing.T) {
	f, h := newPrivacyFixture(t)
	f.fail = true
	if fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")).Code != 409 || f.active != "" || f.stops != 1 {
		t.Fatal("lost ack left mask")
	}
	f.fail = false
	fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.control.maintain(ctx)
	if f.active != "" || f.stops != 2 {
		t.Fatal("shutdown leaves mask")
	}
}
func TestPrivacyRealDesktopWorkerStatusAndEOF(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_PRIVACY_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_PRIVACY_TEST_WORKER for desktop worker integration")
	}
	p := &probe{executable: executable, argument: "--privacy-probe", maxOutput: 4096, timeout: 3 * time.Second}
	defer p.stop()
	result, err := p.read(`privacy:{"op":"status"}`)
	var state privacyResponse
	if err != nil || json.Unmarshal(result, &state) != nil || !state.OK || state.Active || state.Lease != "" {
		t.Fatal(string(result), err)
	}
	started := time.Now()
	p.stop()
	if time.Since(started) > 2*time.Second {
		t.Fatal("worker did not exit on stdin EOF")
	}
}

func TestPrivacyRevocationDuringWorkerReply(t *testing.T) {
	for _, op := range []string{"start", "status"} {
		t.Run(op, func(t *testing.T) {
			f, h := newPrivacyFixture(t)
			if op == "status" && fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")).Code != 200 {
				t.Fatal("start")
			}
			read := f.control.read
			f.control.read = func(command string) (json.RawMessage, error) {
				response, err := read(command)
				if strings.Contains(command, `"op":"`+op+`"`) {
					filePairing(t, f.control.clients, []byte("second"))
				}
				return response, err
			}
			body := privacyBody(op)
			if op == "status" {
				body = `{"op":"status"}`
			}
			response := fileCall(h, []byte("first"), "POST", "/v1/privacy", body)
			if response.Code == 200 || f.active != "" || f.control.request.Lease != "" {
				t.Fatal("revocation lost while worker was running", response.Body.String())
			}
		})
	}
}
