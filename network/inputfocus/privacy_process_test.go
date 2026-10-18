package inputfocus

import (
	"bufio"
	"cliprelay/network/hostprivacy"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Only a disposable stdio protocol child, with no AppKit or shell execution.
func TestOwnedPrivacySubprocess(t *testing.T) {
	if os.Getenv("CLIPRELAY_PRIVACY_PROCESS_TEST") != "1" {
		return
	}
	file, err := os.OpenFile(os.Getenv("CLIPRELAY_PRIVACY_PROCESS_STARTS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(2)
	}
	_, _ = file.WriteString("started\n")
	_ = file.Close()
	ttl, _ := strconv.Atoi(os.Getenv("CLIPRELAY_PRIVACY_PROCESS_TTL"))
	if ttl <= 0 {
		ttl = 15000
	}
	reader := bufio.NewScanner(os.Stdin)
	var lease string
	var deadline time.Time
	active := false
	for reader.Scan() {
		var request hostprivacy.Request
		if json.Unmarshal(reader.Bytes(), &request) != nil {
			os.Exit(2)
		}
		switch request.Op {
		case "exit":
			os.Exit(0)
		case "prepare":
			lease = request.Lease
			deadline = time.Now().Add(time.Duration(ttl) * time.Millisecond)
		case "activate":
			active = true
		case "renew":
			deadline = time.Now().Add(time.Duration(ttl) * time.Millisecond)
		}
		value := hostprivacy.Response{OK: true, Supported: true, Prepared: true, Active: active, Lease: lease, ExpiresMs: deadline.Sub(time.Now()).Milliseconds(), Identity: &hostprivacy.Identity{PID: os.Getpid(), BirthSec: 100, BirthUsec: 1, Windows: []hostprivacy.Window{{ID: 3, Display: 4}}}}
		if json.NewEncoder(os.Stdout).Encode(value) != nil {
			os.Exit(2)
		}
	}
	os.Exit(0)
}

func newPrivacyProcessFixture(t *testing.T, ttl int) (*privacyProcess, string) {
	t.Helper()
	starts := filepath.Join(t.TempDir(), "starts")
	t.Setenv("CLIPRELAY_PRIVACY_PROCESS_TEST", "1")
	t.Setenv("CLIPRELAY_PRIVACY_PROCESS_STARTS", starts)
	t.Setenv("CLIPRELAY_PRIVACY_PROCESS_TTL", strconv.Itoa(ttl))
	worker := &privacyProcess{probe: &probe{ctx: context.Background(), executable: os.Args[0], arguments: []string{"-test.run=^TestOwnedPrivacySubprocess$"}, observeExit: true, noRestart: true, maxOutput: 8192, timeout: time.Second}}
	t.Cleanup(func() { _ = worker.Close() })
	return worker, starts
}

func TestManagedPrivacyProcessCannotRestartAnEndedLease(t *testing.T) {
	worker, starts := newPrivacyProcessFixture(t, 15000)
	if value, err := worker.Read(context.Background(), hostprivacy.Request{Op: "prepare", Lease: privacyTestLease}); err != nil || value.Identity.PID != worker.PID() || !worker.Alive() {
		t.Fatal("owned worker prepare", value, err)
	}
	if _, err := worker.Read(context.Background(), hostprivacy.Request{Op: "exit"}); err == nil {
		t.Fatal("dead worker returned response")
	}
	if _, err := worker.Read(context.Background(), hostprivacy.Request{Op: "prepare", Lease: privacyTestLease}); err == nil {
		t.Fatal("old lease restarted process")
	}
	data, err := os.ReadFile(starts)
	if err != nil || string(data) != "started\n" {
		t.Fatal("worker was replaced", string(data), err)
	}
}

func TestManagedPrivacyExpiryReapsIdleWorkerAndInterruptsEngineWait(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		name := "idle"
		if blocked {
			name = "blocked-engine"
		}
		t.Run(name, func(t *testing.T) {
			worker, _ := newPrivacyProcessFixture(t, 1000)
			state := privacyEngineFixture()
			block := false
			broker := &managedPrivacy{parent: context.Background(), now: time.Now, create: func() (privacyOwnedWorker, error) { return worker, nil }}
			broker.engine = func(ctx context.Context, q *privacyEngineRequest) (privacyEngineState, error) {
				if q == nil {
					return state, nil
				}
				if block && q.Op == "status" {
					<-ctx.Done()
					return privacyEngineState{}, ctx.Err()
				}
				if q.Op == "release" {
					if worker.Alive() {
						t.Fatal("released live worker")
					}
					return privacyEngineFixture(), nil
				}
				state = privacyEngineState{Protocol: 1, privacyBinding: q.privacyBinding, Supported: true, Retained: true, Authorized: true, Ready: true, Epoch: 2, Generation: 7, FirstFrame: 11, ExpiresMs: 15000, Outcome: "status"}
				if q.Op == "prepare" {
					state.Outcome = "accepted"
				}
				return state, nil
			}
			t.Cleanup(broker.close)
			request := privacyRequest{"start", testDisplayInstance, 10, privacyTestLease}
			owner := strings.Repeat("a", 64)
			if value, err := broker.handle(context.Background(), "start", request, owner); err != nil || !value.Active {
				t.Fatal("fixture start", value, err)
			}
			worker.probe.mu.Lock()
			exited := worker.probe.exitDone
			worker.probe.mu.Unlock()
			started := time.Now()
			if blocked {
				block = true
				if value, err := broker.handle(context.Background(), "status", request, owner); err == nil || value.Active {
					t.Fatal("blocked engine kept lease", err)
				}
			}
			select {
			case <-exited:
			case <-time.After(3 * time.Second):
				t.Fatal("broker expiry did not reap owned idle worker")
			}
			if worker.Alive() || time.Since(started) > 2500*time.Millisecond {
				t.Fatal("expiry exceeded bounded recovery")
			}
		})
	}
}
