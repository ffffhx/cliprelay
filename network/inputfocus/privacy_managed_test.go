package inputfocus

import (
	"cliprelay/network/hostprivacy"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// These controlled providers exercise ordering and failure recovery. They are
// deliberately not evidence of a native window or an actual encoded frame.
type managedPrivacyFixture struct {
	t                                                *testing.T
	broker                                           *managedPrivacy
	request                                          privacyRequest
	worker                                           *managedPrivacyWorkerFixture
	now, engineDeadline                              time.Time
	state                                            privacyEngineState
	created, activated, released, polled, readyAfter int
	events                                           []string
	afterEngine                                      func(*privacyEngineRequest, *privacyEngineState) error
	afterWorker                                      func(string, *hostprivacy.Response) error
}
type managedPrivacyWorkerFixture struct {
	f                       *managedPrivacyFixture
	alive, active, prepared bool
	deadline                time.Time
	identity                hostprivacy.Identity
	closeError              error
}

func newManagedPrivacyFixture(t *testing.T) *managedPrivacyFixture {
	f := &managedPrivacyFixture{t: t, now: time.Now(), readyAfter: 2, request: privacyRequest{"start", testDisplayInstance, 10, privacyTestLease}}
	f.state = privacyEngineState{Protocol: 1, privacyBinding: privacyBinding{Instance: testDisplayInstance}, Supported: true, Epoch: 1, Outcome: "status"}
	f.broker = &managedPrivacy{parent: context.Background(), now: func() time.Time { return f.now }, engine: f.engine, create: func() (privacyOwnedWorker, error) {
		f.created++
		f.worker = &managedPrivacyWorkerFixture{f: f, alive: true, identity: hostprivacy.Identity{PID: 321 + f.created, BirthSec: 100, BirthUsec: 2, Windows: []hostprivacy.Window{{ID: 3, Display: 4}}}}
		return f.worker, nil
	}}
	t.Cleanup(func() {
		if f.worker != nil {
			f.worker.closeError = nil
		}
		f.afterEngine = nil
		f.broker.close()
	})
	return f
}
func (f *managedPrivacyFixture) call(op string) (privacyResponse, error) {
	return f.broker.handle(context.Background(), op, f.request, strings.Repeat("a", 64))
}
func (f *managedPrivacyFixture) engine(ctx context.Context, q *privacyEngineRequest) (privacyEngineState, error) {
	if ctx.Err() != nil {
		return privacyEngineState{}, ctx.Err()
	}
	if q != nil {
		f.events = append(f.events, "engine:"+q.Op)
		switch q.Op {
		case "prepare":
			if f.worker == nil || !f.worker.prepared || f.worker.active || q.Worker.PID != f.worker.PID() {
				f.t.Fatal("filter registered without invisible owned worker")
			}
			f.state = privacyEngineState{Protocol: 1, privacyBinding: q.privacyBinding, Supported: true, Retained: true, Authorized: true, Epoch: f.state.Epoch + 1, Outcome: "accepted"}
			f.engineDeadline = f.now.Add(15 * time.Second)
			f.polled = 0
		case "status":
			f.state.Outcome = "status"
			f.polled++
			if f.state.Authorized && f.polled >= f.readyAfter {
				f.state.Ready = true
				f.state.Generation = 7
				f.state.FirstFrame = 101
			}
		case "renew":
			if !f.now.Before(f.engineDeadline) {
				return privacyEngineState{}, errors.New("engine expired")
			}
			f.state.Outcome = "renewed"
			f.engineDeadline = f.now.Add(15 * time.Second)
		case "release":
			if f.worker != nil && f.worker.alive {
				f.t.Fatal("filter removed while worker might still own masks")
			}
			f.released++
			f.state = privacyEngineState{Protocol: 1, privacyBinding: privacyBinding{Instance: testDisplayInstance}, Supported: true, Epoch: f.state.Epoch + 1, Outcome: "released"}
		}
	} else {
		f.state.Outcome = "status"
	}
	if f.state.Authorized {
		f.state.ExpiresMs = f.engineDeadline.Sub(f.now).Milliseconds()
	}
	value := f.state
	if f.afterEngine != nil {
		if err := f.afterEngine(q, &value); err != nil {
			return value, err
		}
	}
	return value, nil
}
func (w *managedPrivacyWorkerFixture) PID() int    { return w.identity.PID }
func (w *managedPrivacyWorkerFixture) Alive() bool { return w.alive }
func (w *managedPrivacyWorkerFixture) Close() error {
	w.f.events = append(w.f.events, "worker:close")
	if w.closeError != nil {
		return w.closeError
	}
	w.alive, w.active = false, false
	return nil
}
func (w *managedPrivacyWorkerFixture) Read(ctx context.Context, q hostprivacy.Request) (hostprivacy.Response, error) {
	if ctx.Err() != nil {
		return hostprivacy.Response{}, ctx.Err()
	}
	f := w.f
	f.events = append(f.events, "worker:"+q.Op)
	if !w.alive {
		return hostprivacy.Response{}, errors.New("worker dead")
	}
	switch q.Op {
	case "prepare":
		w.prepared = true
		w.deadline = f.now.Add(15 * time.Second)
	case "activate":
		if !f.state.Ready || !f.state.Authorized {
			f.t.Fatal("mask activated before filtered encoded readiness")
		}
		w.active = true
		f.activated++
	case "renew":
		if !w.active || !f.now.Before(w.deadline) {
			return hostprivacy.Response{}, errors.New("worker expired")
		}
		w.deadline = f.now.Add(15 * time.Second)
	}
	value := hostprivacy.Response{OK: true, Supported: true, Prepared: w.prepared, Active: w.active, Lease: f.request.Lease, Identity: &w.identity, ExpiresMs: w.deadline.Sub(f.now).Milliseconds()}
	if f.afterWorker != nil {
		if err := f.afterWorker(q.Op, &value); err != nil {
			return value, err
		}
	}
	return value, nil
}
func TestManagedPrivacyFilterHandshakeAndConfirmedDeath(t *testing.T) {
	f := newManagedPrivacyFixture(t)
	value, err := f.call("start")
	if err != nil || !value.Active || f.activated != 1 || f.broker.generation != 7 {
		t.Fatal("start", value, err)
	}
	if _, err = f.call("stop"); err != nil || f.worker.alive || f.released != 1 {
		t.Fatal("stop", err)
	}
	if _, err = f.call("start"); err == nil || f.created != 1 {
		t.Fatal("old lease reactivated")
	}
	f.request.Lease = strings.Repeat("b", 32)
	if _, err = f.call("start"); err != nil || f.created != 2 {
		t.Fatal("fresh explicit lease", err)
	}
	current := f.request
	f.request.Lease = privacyTestLease
	for _, op := range []string{"renew", "stop", "start"} {
		if _, err = f.call(op); err == nil || !f.worker.active {
			t.Fatal("foreign operation disturbed current worker", op, err)
		}
	}
	f.request = current
}
func TestManagedPrivacyPreparationCannotClaimUnprovenReadiness(t *testing.T) {
	for _, cause := range []string{"no-frame", "foreign-owner", "withdrawn", "worker-pid", "lost-prepare"} {
		t.Run(cause, func(t *testing.T) {
			f := newManagedPrivacyFixture(t)
			f.afterEngine = func(q *privacyEngineRequest, s *privacyEngineState) error {
				if q != nil && q.Op == "status" {
					switch cause {
					case "no-frame":
						s.Ready = true
						s.Generation = 7
						s.FirstFrame = 0
					case "foreign-owner":
						s.Owner = strings.Repeat("c", 64)
					case "withdrawn":
						s.Authorized = false
						s.Ready = false
						s.FirstFrame = 0
						s.ExpiresMs = 0
						s.Reason = "stream_changed"
					}
				}
				if cause == "lost-prepare" && q != nil && q.Op == "prepare" {
					return errors.New("lost ack")
				}
				return nil
			}
			if cause == "worker-pid" {
				f.afterWorker = func(op string, r *hostprivacy.Response) error {
					if op == "prepare" {
						identity := *r.Identity
						identity.PID++
						r.Identity = &identity
					}
					return nil
				}
			}
			if _, err := f.call("start"); err == nil || f.activated != 0 || f.worker.alive {
				t.Fatal("unproven privacy accepted", cause, err)
			}
		})
	}
}
func TestManagedPrivacyCancelledPreparationAndLostActivationRestore(t *testing.T) {
	for _, cause := range []string{"cancelled-owner", "never-ready", "lost-activation", "changed-after-activation"} {
		t.Run(cause, func(t *testing.T) {
			f := newManagedPrivacyFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.broker.parent = ctx
			f.afterWorker = func(op string, r *hostprivacy.Response) error {
				if cause == "cancelled-owner" && op == "prepare" {
					cancel()
				}
				if cause == "lost-activation" && op == "activate" {
					return errors.New("lost activation ack")
				}
				return nil
			}
			if cause == "changed-after-activation" {
				f.afterEngine = func(q *privacyEngineRequest, s *privacyEngineState) error {
					if f.activated > 0 && q != nil && q.Op == "status" {
						s.Generation++
					}
					return nil
				}
			}
			requestCtx := context.Background()
			if cause == "never-ready" {
				f.readyAfter = 1000
				var end context.CancelFunc
				requestCtx, end = context.WithTimeout(requestCtx, 10*time.Millisecond)
				defer end()
			}
			if _, err := f.broker.handle(requestCtx, "start", f.request, strings.Repeat("a", 64)); err == nil || f.worker.alive || f.worker.active {
				t.Fatal("failure left mask", err)
			}
		})
	}
}
func TestManagedPrivacyRenewalCannotReviveExpiredGrant(t *testing.T) {
	f := newManagedPrivacyFixture(t)
	if _, err := f.call("start"); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(10 * time.Second)
	if value, err := f.call("renew"); err != nil || !value.Active || value.ExpiresMs != 15000 {
		t.Fatal("renew", value, err)
	}
	f.now = f.broker.deadline.Add(-500 * time.Millisecond)
	renewed := false
	f.afterWorker = func(op string, r *hostprivacy.Response) error {
		if op == "renew" {
			renewed = true
		}
		if op == "status" && renewed {
			f.now = f.now.Add(time.Second)
		}
		return nil
	}
	if _, err := f.call("renew"); err == nil || f.worker.alive || f.broker.worker != nil {
		t.Fatal("late reply revived authority", err)
	}
	if _, err := f.call("renew"); err == nil || f.created != 1 {
		t.Fatal("expired lease restarted worker")
	}
}
func TestManagedPrivacyUnknownDeathRetainsFilterAndRetries(t *testing.T) {
	f := newManagedPrivacyFixture(t)
	if _, err := f.call("start"); err != nil {
		t.Fatal(err)
	}
	f.worker.closeError = errors.New("death not confirmed")
	if _, err := f.call("stop"); err == nil || f.released != 0 || !f.broker.draining || f.broker.worker == nil {
		t.Fatal("unconfirmed restoration claimed", err)
	}
	if _, err := f.call("renew"); err == nil || f.released != 0 || f.activated != 1 {
		t.Fatal("draining grant renewed", err)
	}
	f.worker.closeError = nil
	if _, err := f.call("stop"); err != nil || f.released != 1 || f.worker.alive {
		t.Fatal("recovery not retried", err)
	}
}
func TestManagedPrivacyPollingWithdrawsChangedCaptureAndWorker(t *testing.T) {
	for _, cause := range []string{"capture", "epoch", "worker-death", "worker-birth"} {
		t.Run(cause, func(t *testing.T) {
			f := newManagedPrivacyFixture(t)
			if _, err := f.call("start"); err != nil {
				t.Fatal(err)
			}
			f.afterEngine = func(q *privacyEngineRequest, s *privacyEngineState) error {
				if q != nil && q.Op == "status" {
					if cause == "capture" {
						s.Generation++
					}
					if cause == "epoch" {
						s.Epoch++
					}
				}
				return nil
			}
			if cause == "worker-death" {
				f.worker.alive = false
			}
			if cause == "worker-birth" {
				f.worker.identity.BirthSec++
			}
			if _, err := f.call("status"); err == nil || f.worker.alive || f.broker.worker != nil {
				t.Fatal("unhealthy privacy retained", err)
			}
		})
	}
}
