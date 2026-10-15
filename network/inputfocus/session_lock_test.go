package inputfocus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type lockFixture struct {
	control                        *sessionLockControl
	state                          displayState
	result                         sessionLockState
	now                            time.Time
	commits, arms, renews, cancels int
	engineError, commitError       bool
}

func lockBody(op string) string {
	b, _ := json.Marshal(privacyRequest{op, testDisplayInstance, 10, privacyTestLease})
	return string(b)
}
func newLockFixture(t *testing.T) (*lockFixture, http.Handler) {
	t.Helper()
	f := &lockFixture{now: time.Now(), state: displayFixture([]byte("first"), []byte("second")), result: sessionLockState{OK: true, Supported: true, State: "off"}}
	f.state.Streams = f.state.Streams[:1]
	f.control = &sessionLockControl{clients: filepath.Join(t.TempDir(), "clients.json"), now: func() time.Time { return f.now },
		provider: func(context.Context, bool, *displaySelection) (displayState, error) {
			if f.engineError {
				return displayState{}, errors.New("unknown engine")
			}
			return f.state, nil
		},
		read: func(command string) (json.RawMessage, error) {
			var q struct{ Op, Lease string }
			if !strings.HasPrefix(command, "session-lock:") || json.Unmarshal([]byte(command[13:]), &q) != nil {
				t.Fatal("bad worker command")
			}
			switch q.Op {
			case "arm":
				f.arms++
				f.result = sessionLockState{OK: true, Supported: true, State: "armed", Lease: q.Lease, ExpiresMs: 15000}
			case "renew":
				f.renews++
				if f.result.State != "armed" || f.result.Lease != q.Lease {
					return json.RawMessage(`{"ok":false,"code":"LOCK_EXPIRED"}`), nil
				}
			case "cancel":
				f.cancels++
				f.result = sessionLockState{OK: true, Supported: true, State: "off"}
			case "commit":
				f.commits++
				f.result.State = "requested"
				f.result.ExpiresMs = 5000
				if f.commitError {
					return nil, errors.New("lost reply")
				}
			}
			b, err := json.Marshal(f.result)
			return b, err
		}}
	filePairing(t, f.control.clients, []byte("first"), []byte("second"))
	return f, f.control.handler(http.NotFoundHandler())
}
func lockCall(h http.Handler, op string) int {
	return fileCall(h, []byte("first"), "POST", "/v1/session-lock", lockBody(op)).Code
}
func (f *lockFixture) end() { f.state.Streams = nil; f.state.Phase = "idle" }
func (f *lockFixture) tick(ms int64) {
	f.now = f.now.Add(time.Duration(ms) * time.Millisecond)
	f.control.check(context.Background())
}

func TestSessionLockRequiresOwnedExclusiveLiveStream(t *testing.T) {
	f, h := newLockFixture(t)
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if fileCall(h, peer, "POST", "/v1/session-lock", lockBody("arm")).Code != 403 {
			t.Fatal("unpaired")
		}
	}
	for _, body := range []string{lockBody("commit"), `{"op":"arm"}`, lockBody("arm") + "{}", strings.Replace(lockBody("arm"), `"op":"arm"`, `"op":"arm","owner":"spoof"`, 1)} {
		if fileCall(h, []byte("first"), "POST", "/v1/session-lock", body).Code != 400 {
			t.Fatal("invalid request accepted", body)
		}
	}
	if fileCall(h, []byte("second"), "POST", "/v1/session-lock", lockBody("arm")).Code != 409 {
		t.Fatal("foreign stream")
	}
	f.state = displayFixture([]byte("first"), []byte("second"))
	if lockCall(h, "arm") != 409 {
		t.Fatal("shared stream")
	}
	f.state.Streams = f.state.Streams[:1]
	f.state.Phase = "switching"
	if lockCall(h, "arm") != 409 {
		t.Fatal("unready stream")
	}
	f.state.Phase = "active"
	if f.arms != 0 || lockCall(h, "arm") != 200 || f.commits != 0 {
		t.Fatal("arming had side effect")
	}
	if fileCall(h, []byte("second"), "POST", "/v1/session-lock", lockBody("disarm")).Code != 409 {
		t.Fatal("foreign disarm")
	}
	response := fileCall(h, []byte("second"), "POST", "/v1/session-lock", `{"op":"status"}`)
	if strings.Contains(response.Body.String(), privacyTestLease) || strings.Contains(response.Body.String(), `"state":"armed"`) {
		t.Fatal("intent leaked")
	}
}
func TestSessionLockConfirmedEndAndOneShotCommit(t *testing.T) {
	f, h := newLockFixture(t)
	if lockCall(h, "arm") != 200 {
		t.Fatal("arm")
	}
	// No phone heartbeat is needed: the computer owns this explicit session intent.
	for i := 0; i < 10; i++ {
		f.tick(4000)
	}
	if f.renews != 10 || f.commits != 0 || f.result.State != "armed" {
		t.Fatal("live stream not retained")
	}
	f.end()
	f.tick(1)
	f.tick(1000)
	if f.commits != 0 {
		t.Fatal("single idle observation locked")
	}
	f.tick(1000)
	if f.commits != 1 || f.control.result.State != "requested" {
		t.Fatal("confirmed end did not request lock")
	}
	if lockCall(h, "disarm") != 409 {
		t.Fatal("accepted OS request reported as cancelled")
	}
	f.result.State = "locked"
	f.result.ExpiresMs = 0
	f.tick(1000)
	if f.control.result.State != "locked" {
		t.Fatal("confirmation lost")
	}
	for i := 0; i < 4; i++ {
		f.tick(1000)
	}
	if f.commits != 1 {
		t.Fatal("repeated lock")
	}
}

func TestSessionLockCancelledTokenCannotRearm(t *testing.T) {
	for _, initiallyArmed := range []bool{false, true} {
		f, h := newLockFixture(t)
		if initiallyArmed && lockCall(h, "arm") != 200 {
			t.Fatal("initial arm")
		}
		if lockCall(h, "disarm") != 200 {
			t.Fatal("disarm")
		}
		if lockCall(h, "arm") != 409 {
			t.Fatalf("a delayed arm reinstated a cancelled token (initially armed=%t)", initiallyArmed)
		}
		f.end()
		f.tick(1)
		f.tick(2000)
		if f.commits != 0 {
			t.Fatal("cancelled intent committed")
		}
	}
}

func TestSessionLockWorkerRestartReportsUnboundOff(t *testing.T) {
	f, h := newLockFixture(t)
	if lockCall(h, "arm") != 200 {
		t.Fatal("arm")
	}
	// A restarted worker has no pending intent even while the engine still
	// reports the original stream and the host renewal deadline has not elapsed.
	f.result = sessionLockState{OK: true, Supported: true, State: "off"}
	response := fileCall(h, []byte("first"), "POST", "/v1/session-lock", `{"op":"status"}`)
	var state sessionLockState
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.State != "off" || state.Lease != "" || state.Instance != "" || state.Stream != 0 {
		t.Fatalf("off state retained stale binding: %s", response.Body.String())
	}
	if f.control.request.Lease != "" || lockCall(h, "arm") != 409 {
		t.Fatal("restarted worker intent could be replayed")
	}
}

func TestSessionLockDisarmAfterLostCommitCannotClaimOff(t *testing.T) {
	f, h := newLockFixture(t)
	if lockCall(h, "arm") != 200 {
		t.Fatal("arm")
	}
	f.commitError = true
	f.end()
	f.tick(1)
	f.tick(2000)
	if f.control.result.State != "failed" || f.result.State != "requested" {
		t.Fatal("lost-ack fixture")
	}
	read := f.control.read
	f.control.read = func(command string) (json.RawMessage, error) {
		if strings.Contains(command, `"op":"cancel"`) {
			return json.RawMessage(`{"ok":false,"code":"LOCK_ALREADY_REQUESTED"}`), nil
		}
		return read(command)
	}
	if lockCall(h, "disarm") != 409 {
		t.Fatal("an initiated OS lock was falsely reported as cancelled")
	}
}

func TestSessionLockCancellationWaitsForWorkerConfirmation(t *testing.T) {
	f, h := newLockFixture(t)
	if lockCall(h, "arm") != 200 {
		t.Fatal("arm")
	}
	blocked := true
	read := f.control.read
	f.control.read = func(command string) (json.RawMessage, error) {
		if blocked && strings.Contains(command, `"op":"cancel"`) {
			return nil, errors.New("lost cancel response")
		}
		return read(command)
	}
	if lockCall(h, "disarm") != 503 || !f.control.cancelling || f.control.request.Lease == "" {
		t.Fatal("unconfirmed cancel was forgotten")
	}
	f.tick(4000)
	f.tick(4000)
	response := fileCall(h, []byte("first"), "POST", "/v1/session-lock", `{"op":"status"}`)
	if response.Code != 503 || !strings.Contains(response.Body.String(), `"cancelProtected":true`) || f.renews != 0 || f.commits != 0 {
		t.Fatal("pending cancellation renewed, locked or appeared off", response.Body.String())
	}
	blocked = false
	f.tick(1)
	if f.control.cancelling || f.control.request.Lease != "" || f.result.State != "off" || lockCall(h, "arm") != 409 {
		t.Fatal("confirmed cancel did not retire the old token")
	}
	fresh := strings.ReplaceAll(lockBody("arm"), privacyTestLease, strings.Repeat("b", 32))
	if fileCall(h, []byte("first"), "POST", "/v1/session-lock", fresh).Code != 200 {
		t.Fatal("fresh explicit intent was blocked")
	}
}

func TestSessionLockRetirementBoundAndActiveReservation(t *testing.T) {
	f, h := newLockFixture(t)
	for i := 0; i < 255; i++ {
		body := strings.ReplaceAll(lockBody("disarm"), privacyTestLease, fmt.Sprintf("%032x", i))
		if fileCall(h, []byte("first"), "POST", "/v1/session-lock", body).Code != 200 {
			t.Fatal("bounded cancellation receipt")
		}
	}
	if lockCall(h, "arm") != 200 || len(f.control.retired) != 256 {
		t.Fatal("active intent did not reserve a receipt slot")
	}
	if lockCall(h, "disarm") != 200 || lockCall(h, "arm") != 409 {
		t.Fatal("full receipt table lost active cancellation")
	}
	extra := strings.ReplaceAll(lockBody("disarm"), privacyTestLease, strings.Repeat("c", 32))
	if fileCall(h, []byte("first"), "POST", "/v1/session-lock", extra).Code != 429 || len(f.control.retired) != 256 {
		t.Fatal("receipt bound not enforced")
	}
	f.now = f.now.Add(2*time.Minute + time.Second)
	if fileCall(h, []byte("first"), "POST", "/v1/session-lock", extra).Code != 200 || len(f.control.retired) != 1 {
		t.Fatal("expired cancellation receipts retained capacity")
	}
}
func TestSessionLockUncertaintyAndOtherSessionsNeverLock(t *testing.T) {
	for _, cause := range []string{"shared", "replacement", "engine-restart", "revocation", "unknown-expired", "worker-cancelled", "nonidle-empty"} {
		t.Run(cause, func(t *testing.T) {
			f, h := newLockFixture(t)
			lockCall(h, "arm")
			switch cause {
			case "shared":
				f.state = displayFixture([]byte("first"), []byte("second"))
			case "replacement":
				f.state.Streams[0].ID++
			case "engine-restart":
				f.state.Instance = "aaaaaaaa-2222-3333-4444-555555555555"
			case "revocation":
				filePairing(t, f.control.clients, []byte("second"))
			case "unknown-expired":
				f.engineError = true
			case "worker-cancelled":
				f.result.State = "cancelled"
				f.result.ExpiresMs = 0
			case "nonidle-empty":
				f.state.Streams = nil
				f.state.Phase = "starting"
			}
			f.tick(4000)
			f.tick(12000)
			f.end()
			f.engineError = false
			f.tick(3000)
			if f.commits != 0 || f.control.request.Lease != "" {
				t.Fatal("unsafe lock or retained intent")
			}
		})
	}
}
func TestSessionLockTransientControlFailureDoesNotMeanEnd(t *testing.T) {
	f, h := newLockFixture(t)
	lockCall(h, "arm")
	f.engineError = true
	f.tick(4000)
	f.tick(4000)
	if f.commits != 0 || f.renews != 0 || f.control.request.Lease == "" {
		t.Fatal("uncertainty locks or immediately cancels")
	}
	f.engineError = false
	f.state.Phase = "switching"
	f.tick(1000)
	if f.renews != 1 || f.commits != 0 {
		t.Fatal("same stream reconstruction cancels or locks")
	}
	f.state.Phase = "active"
	f.end()
	f.tick(1000)
	f.tick(2000)
	if f.commits != 1 {
		t.Fatal("genuine later end lost")
	}
}
func TestSessionLockRechecksBeforeCommit(t *testing.T) {
	for _, change := range []string{"stream", "revoked", "unknown"} {
		t.Run(change, func(t *testing.T) {
			f, h := newLockFixture(t)
			lockCall(h, "arm")
			f.end()
			f.tick(1)
			reads := 0
			original := f.control.provider
			f.control.provider = func(ctx context.Context, refresh bool, selection *displaySelection) (displayState, error) {
				reads++
				if reads == 2 {
					switch change {
					case "stream":
						f.state = displayFixture([]byte("first"), []byte("second"))
					case "revoked":
						filePairing(t, f.control.clients, []byte("second"))
					case "unknown":
						return displayState{}, errors.New("unavailable")
					}
				}
				return original(ctx, refresh, selection)
			}
			f.tick(2000)
			if f.commits != 0 || reads != 2 {
				t.Fatal("final check not enforced")
			}
		})
	}
}
func TestSessionLockDisarmShutdownAndLostAcknowledgment(t *testing.T) {
	f, h := newLockFixture(t)
	lockCall(h, "arm")
	if lockCall(h, "disarm") != 200 {
		t.Fatal("disarm")
	}
	f.end()
	f.tick(2000)
	f.tick(2000)
	if f.commits != 0 {
		t.Fatal("disarm locked")
	}
	f, h = newLockFixture(t)
	lockCall(h, "arm")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.control.maintain(ctx)
	if f.commits != 0 || f.result.State != "off" {
		t.Fatal("shutdown locked")
	}
	f, h = newLockFixture(t)
	lockCall(h, "arm")
	f.commitError = true
	f.end()
	f.tick(1)
	f.tick(2000)
	f.tick(4000)
	f.tick(4000)
	if f.commits != 1 || f.control.result.State != "failed" {
		t.Fatal("lost acknowledgment retried or claimed success")
	}
}
func TestSessionLockRealWorkerStatusWithoutLocking(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_SESSION_LOCK_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_SESSION_LOCK_TEST_WORKER")
	}
	p := &probe{executable: executable, argument: "--privacy-probe", maxOutput: 4096, timeout: 3 * time.Second}
	defer p.stop()
	result, err := p.read(`session-lock:{"op":"status"}`)
	var state sessionLockState
	if err != nil || json.Unmarshal(result, &state) != nil || !state.OK || state.State != "off" || state.Lease != "" {
		t.Fatal(string(result), err)
	}
	if !state.Supported {
		t.Fatal("test desktop could not register Windows session notifications")
	}
	t.Log("real desktop worker registered Windows session notifications; no lock was requested")
	// Invalid commit has no armed token, so the native LockWorkStation path is unreachable.
	result, err = p.read(`session-lock:{"op":"commit","lease":"` + privacyTestLease + `"}`)
	if err != nil || json.Unmarshal(result, &state) != nil || state.OK || state.Code != "LOCK_EXPIRED" {
		t.Fatal(string(result), err)
	}
	p.stop()
}

func TestSessionLockWorkerResponseCannotBypassRevocation(t *testing.T) {
	for _, op := range []string{"arm", "status"} {
		t.Run(op, func(t *testing.T) {
			f, h := newLockFixture(t)
			if op == "status" {
				lockCall(h, "arm")
			}
			read := f.control.read
			f.control.read = func(command string) (json.RawMessage, error) {
				response, err := read(command)
				if strings.Contains(command, `"op":"`+op+`"`) {
					filePairing(t, f.control.clients, []byte("second"))
				}
				return response, err
			}
			body := lockBody(op)
			if op == "status" {
				body = `{"op":"status"}`
			}
			response := fileCall(h, []byte("first"), "POST", "/v1/session-lock", body)
			if response.Code == 200 || f.control.request.Lease != "" || f.commits != 0 {
				t.Fatal("revoked response escaped", response.Body.String())
			}
		})
	}
}
