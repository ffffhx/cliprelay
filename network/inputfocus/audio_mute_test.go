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

func audioBody(op string) string {
	b, _ := json.Marshal(audioMuteRequest{privacyRequest{op, testDisplayInstance, 10, privacyTestLease}, 7})
	return string(b)
}

type audioFixture struct {
	control            *audioMuteControl
	state              displayState
	now                time.Time
	active             string
	starts, stops      int
	lostAck, stopFails bool
	afterStart         func()
}

func newAudioFixture(t *testing.T) (*audioFixture, http.Handler) {
	t.Helper()
	f := &audioFixture{now: time.Now(), state: displayFixture([]byte("first"), []byte("second"))}
	f.state.Streams = f.state.Streams[:1]
	f.state.Streams[0].Audio = &displayAudio{Capture: "process", Generation: 7, Ready: true}
	f.control = &audioMuteControl{clients: filepath.Join(t.TempDir(), "clients.json"), now: func() time.Time { return f.now },
		provider: func(context.Context, bool, *displaySelection) (displayState, error) { return f.state, nil },
		read: func(command string) (json.RawMessage, error) {
			var q struct{ Op, Lease string }
			if !strings.HasPrefix(command, "audio-mute:") || json.Unmarshal([]byte(command[11:]), &q) != nil {
				t.Fatal("worker command")
			}
			switch q.Op {
			case "start":
				f.starts++
				f.active = q.Lease
				if f.afterStart != nil {
					f.afterStart()
				}
				if f.lostAck {
					return nil, errors.New("lost ack")
				}
			case "renew":
				if f.active != q.Lease {
					return json.RawMessage(`{"ok":false,"code":"AUDIO_EXPIRED"}`), nil
				}
			case "stop":
				f.stops++
				if f.stopFails {
					return nil, errors.New("worker unavailable")
				}
				f.active = ""
			}
			expires := int64(0)
			if f.active != "" {
				expires = 15000
			}
			return json.Marshal(audioMuteState{privacyResponse: privacyResponse{OK: true, Supported: true, Active: f.active != "", Lease: f.active, ExpiresMs: expires}, Outputs: 2})
		}}
	filePairing(t, f.control.clients, []byte("first"), []byte("second"))
	return f, f.control.handler(http.NotFoundHandler())
}
func audioCall(h http.Handler, peer, op string) int {
	body := audioBody(op)
	if op == "status" {
		body = `{"op":"status"}`
	}
	return fileCall(h, []byte(peer), "POST", "/v1/audio-mute", body).Code
}
func TestAudioMuteAuthorizationAndInput(t *testing.T) {
	f, h := newAudioFixture(t)
	for _, peer := range []string{"", "unknown"} {
		if audioCall(h, peer, "start") != 403 {
			t.Fatal("unpaired")
		}
	}
	for _, body := range []string{`{"op":"start"}`, strings.Replace(audioBody("start"), `"audioGeneration":7`, `"audioGeneration":0`, 1), strings.Replace(audioBody("start"), `"audioGeneration":7`, `"endpoints":["speaker"]`, 1), audioBody("start") + "{}", `{"op":"status","lease":"bad"}`} {
		if fileCall(h, []byte("first"), "POST", "/v1/audio-mute", body).Code != 400 {
			t.Fatal("accepted invalid request", body)
		}
	}
	if audioCall(h, "second", "start") != 409 || f.starts != 0 {
		t.Fatal("foreign stream acquired mute")
	}
	if audioCall(h, "first", "start") != 200 || f.starts != 1 {
		t.Fatal("valid start")
	}
	if audioCall(h, "second", "stop") != 409 || f.active == "" {
		t.Fatal("foreign stop")
	}
	w := fileCall(h, []byte("second"), "POST", "/v1/audio-mute", `{"op":"status"}`)
	if strings.Contains(w.Body.String(), privacyTestLease) || strings.Contains(w.Body.String(), `"active":true`) || strings.Contains(w.Body.String(), `"supported":true`) {
		t.Fatal("owner state leaked", w.Body.String())
	}
}
func TestAudioMuteSystemTapStillBindsFreshGeneration(t *testing.T) {
	f, h := newAudioFixture(t)
	f.state.Streams[0].Audio.Capture = "system-tap"
	if audioCall(h, "first", "start") != 200 || f.starts != 1 {
		t.Fatal("fresh system tap rejected")
	}
	f.state.Streams[0].Audio.Generation++
	if audioCall(h, "first", "renew") != 409 || f.active != "" {
		t.Fatal("replacement tap retained mute")
	}
}

func TestAudioMuteRequiresFreshExclusiveProcessAudio(t *testing.T) {
	for _, kind := range []string{"old-engine", "endpoint", "not-ready", "audio-generation", "instance", "shared", "switching", "video-generation", "unpresented"} {
		t.Run(kind, func(t *testing.T) {
			f, h := newAudioFixture(t)
			switch kind {
			case "old-engine":
				f.state.Streams[0].Audio = nil
			case "endpoint":
				f.state.Streams[0].Audio.Capture = "endpoint"
				f.state.Streams[0].Audio.Ready = false
			case "not-ready":
				f.state.Streams[0].Audio.Ready = false
			case "audio-generation":
				f.state.Streams[0].Audio.Generation++
			case "instance":
				f.state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
			case "shared":
				f.state.Streams = append(f.state.Streams, f.state.Streams[0])
			case "switching":
				f.state.Phase = "switching"
			case "video-generation":
				f.state.Streams[0].Generation++
			case "unpresented":
				f.state.Streams[0].FirstFrame = 0
			}
			if audioCall(h, "first", "start") != 409 || f.starts != 0 {
				t.Fatal("unsafe stream muted")
			}
		})
	}
}
func TestAudioMuteRestoresWithoutPhoneTraffic(t *testing.T) {
	for _, kind := range []string{"expiry", "revoked", "audio-stale", "capture-restarted", "disconnected", "engine-restarted", "local-override"} {
		t.Run(kind, func(t *testing.T) {
			f, h := newAudioFixture(t)
			if audioCall(h, "first", "start") != 200 {
				t.Fatal("start")
			}
			switch kind {
			case "expiry":
				f.now = f.now.Add(15 * time.Second)
			case "revoked":
				filePairing(t, f.control.clients, []byte("second"))
			case "audio-stale":
				f.state.Streams[0].Audio.Ready = false
			case "capture-restarted":
				f.state.Streams[0].Audio.Generation++
			case "disconnected":
				f.state.Streams = nil
			case "engine-restarted":
				f.state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
			case "local-override":
				f.active = ""
			}
			f.control.check(context.Background())
			if f.active != "" || f.control.request.Lease != "" || f.stops != 1 {
				t.Fatal("failed to restore")
			}
			// Even if audio is ready again, retrying the old start cannot undo
			// the cancellation or a manual adjustment made on the computer.
			f.state = displayFixture([]byte("first"), []byte("second"))
			f.state.Streams = f.state.Streams[:1]
			f.state.Streams[0].Audio = &displayAudio{"process", 7, true}
			filePairing(t, f.control.clients, []byte("first"), []byte("second"))
			if audioCall(h, "first", "start") != 409 || f.starts != 1 {
				t.Fatal("retired token reacquired mute")
			}
		})
	}
}
func TestAudioMuteRenewStopAndReorderedStart(t *testing.T) {
	f, h := newAudioFixture(t)
	if audioCall(h, "first", "start") != 200 {
		t.Fatal("start")
	}
	f.now = f.now.Add(10 * time.Second)
	if audioCall(h, "first", "renew") != 200 || audioCall(h, "first", "start") != 200 || f.starts != 1 {
		t.Fatal("renew recreated worker lease")
	}
	f.now = f.now.Add(10 * time.Second)
	f.control.check(context.Background())
	if f.active == "" {
		t.Fatal("renew ignored")
	}
	if audioCall(h, "first", "stop") != 200 || f.active != "" || audioCall(h, "first", "start") != 409 {
		t.Fatal("late restart after stop")
	}
	f, h = newAudioFixture(t)
	if audioCall(h, "first", "stop") != 200 || audioCall(h, "first", "start") != 409 || f.starts != 0 {
		t.Fatal("reordered start undid stop")
	}
}
func TestAudioMuteLostReplyAndRecoveryRetry(t *testing.T) {
	f, h := newAudioFixture(t)
	f.lostAck = true
	f.stopFails = true
	if audioCall(h, "first", "start") != 409 || f.active == "" || !f.control.restoring {
		t.Fatal("lost-ack setup")
	}
	if audioCall(h, "first", "renew") != 409 || f.starts != 1 {
		t.Fatal("renew during recovery")
	}
	f.stopFails = false
	f.control.check(context.Background())
	if f.active != "" || f.control.request.Lease != "" || f.control.restoring {
		t.Fatal("failed stop not retried")
	}
	if audioCall(h, "first", "start") != 409 {
		t.Fatal("lost start replayed")
	}
}
func TestAudioMuteRechecksAfterWorkerResponse(t *testing.T) {
	for _, kind := range []string{"revoke", "audio-stale", "generation"} {
		t.Run(kind, func(t *testing.T) {
			f, h := newAudioFixture(t)
			f.afterStart = func() {
				switch kind {
				case "revoke":
					filePairing(t, f.control.clients, []byte("second"))
				case "audio-stale":
					f.state.Streams[0].Audio.Ready = false
				case "generation":
					f.state.Streams[0].Audio.Generation++
				}
			}
			if audioCall(h, "first", "start") != 409 || f.active != "" || f.stops != 1 {
				t.Fatal("worker reply race retained mute")
			}
		})
	}
}
func TestAudioMuteRejectsMalformedWorkerState(t *testing.T) {
	for _, raw := range []string{`{"ok":true,"active":true,"supported":false}`, `{"ok":true,"expiresMs":1}`, `{"ok":true,"outputs":33}`, `{"ok":true,"supported":true,"recovering":true}`, `{"ok":true,"expiresMs":-1}`} {
		f, _ := newAudioFixture(t)
		f.control.read = func(string) (json.RawMessage, error) { return json.RawMessage(raw), nil }
		if _, err := f.control.worker("status", ""); err == nil {
			t.Fatal("accepted malformed worker", raw)
		}
	}
}
func TestAudioMuteRealWorkerStatusAndEOF(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_AUDIO_MUTE_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_AUDIO_MUTE_TEST_WORKER to compiled audio-mute tests")
	}
	p := &probe{executable: executable, argument: "--audio-mute-probe", maxOutput: 4096, timeout: 3 * time.Second}
	defer p.stop()
	control := &audioMuteControl{read: p.read}
	state, err := control.worker("status", "")
	if err != nil || !state.OK || state.Active || state.Lease != "" || state.Recovering {
		t.Fatal(state, err)
	}
	command := p.cmd
	p.stop()
	if command.ProcessState == nil || !command.ProcessState.Success() {
		t.Fatal("worker did not exit cleanly on EOF")
	}
}

func TestAudioMuteRevocationDuringFinalEngineCheck(t *testing.T) {
	f, h := newAudioFixture(t)
	checks := 0
	f.control.provider = func(context.Context, bool, *displaySelection) (displayState, error) {
		checks++
		if checks == 2 {
			filePairing(t, f.control.clients, []byte("second"))
		}
		return f.state, nil
	}
	if audioCall(h, "first", "start") != 409 || f.active != "" || f.stops != 1 {
		t.Fatal("final engine response bypassed revocation")
	}
}

func TestAudioMuteShutdownRestores(t *testing.T) {
	f, h := newAudioFixture(t)
	if audioCall(h, "first", "start") != 200 {
		t.Fatal("start")
	}
	f.control.cleanupRead = f.control.read
	f.control.read = func(string) (json.RawMessage, error) {
		t.Error("shutdown used cancelled request path")
		return nil, context.Canceled
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.control.maintain(ctx)
	if f.active != "" || f.control.request.Lease != "" || f.stops != 1 {
		t.Fatal("shutdown retained mute")
	}
}

func TestAudioMuteRetirementCapacityAndExpiry(t *testing.T) {
	f, h := newAudioFixture(t)
	for i := 0; i < 256; i++ {
		if !f.control.retire("owner", string(rune(i))) {
			t.Fatal("early limit")
		}
	}
	if audioCall(h, "first", "start") != 429 || f.starts != 0 {
		t.Fatal("capacity limit allowed untracked lease")
	}
	f.now = f.now.Add(2 * time.Minute)
	if audioCall(h, "first", "start") != 200 || len(f.control.retired) != 0 {
		t.Fatal("old canceled tokens did not expire")
	}
}
