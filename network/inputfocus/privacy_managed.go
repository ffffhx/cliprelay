package inputfocus

import (
	"cliprelay/network/hostprivacy"
	"context"
	"errors"
	"slices"
	"sync"
	"time"
)

// A worker is created once per lease. Close returns only after its original
// process has exited; hiding windows or losing the response pipe is insufficient.
type privacyOwnedWorker interface {
	Read(context.Context, hostprivacy.Request) (hostprivacy.Response, error)
	PID() int
	Alive() bool
	Close() error
}

type managedPrivacy struct {
	mu                sync.Mutex
	parent            context.Context
	engine            privacyEngineProvider
	create            func() (privacyOwnedWorker, error)
	now               func() time.Time
	closed            bool
	draining          bool
	worker            privacyOwnedWorker
	identity          *hostprivacy.Identity
	binding           privacyBinding
	epoch, generation uint64
	deadline          time.Time
	retired           map[privacyBinding]time.Time
	leaseContext      context.Context
	cancelLease       context.CancelFunc
	expiry            *time.Timer
}

func (b *managedPrivacy) leaseCall(ctx context.Context) (context.Context, func()) {
	if b.leaseContext == nil {
		return ctx, func() {}
	}
	child, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(b.leaseContext, cancel)
	if b.leaseContext.Err() != nil {
		cancel()
	}
	return child, func() { stop(); cancel() }
}

// Expiry acts without waiting for the public policy's polling tick or a blocked
// engine request. Cancellation interrupts in-flight I/O; Close also reaps an
// idle worker. Reset is allowed only before the original timer fired.
func (b *managedPrivacy) armExpiry() error {
	remaining := b.deadline.Sub(b.now())
	if remaining <= 0 || b.leaseContext.Err() != nil {
		return errors.New("privacy grant expired")
	}
	if b.expiry != nil && !b.expiry.Stop() {
		return errors.New("privacy expiry already started")
	}
	worker, cancel := b.worker, b.cancelLease
	b.expiry = time.AfterFunc(remaining, func() { cancel(); _ = worker.Close() })
	return nil
}

func earlierPrivacyDeadline(a, b time.Time) time.Time {
	if a.IsZero() || b.Before(a) {
		return b
	}
	return a
}

func (b *managedPrivacy) engineCall(ctx context.Context, request *privacyEngineRequest) (privacyEngineState, time.Time, error) {
	if request == nil || request.Op != "release" {
		var end func()
		ctx, end = b.leaseCall(ctx)
		defer end()
	}
	started := b.now()
	state, err := b.engine(ctx, request)
	if err != nil {
		return state, time.Time{}, err
	}
	if !validPrivacyEngineState(state) {
		return privacyEngineState{}, time.Time{}, errors.New("invalid privacy engine state")
	}
	// Request start gives a conservative lower bound despite transport delay.
	return state, started.Add(time.Duration(state.ExpiresMs) * time.Millisecond), nil
}

func (b *managedPrivacy) workerCall(ctx context.Context, op string) (hostprivacy.Response, time.Time, error) {
	ctx, end := b.leaseCall(ctx)
	defer end()
	if ctx.Err() != nil || b.parent.Err() != nil {
		return hostprivacy.Response{}, time.Time{}, context.Canceled
	}
	request := hostprivacy.Request{Op: op, Lease: b.binding.Lease}
	if op == "status" {
		request.Lease = ""
	}
	started := b.now()
	value, err := b.worker.Read(ctx, request)
	if err != nil {
		return value, time.Time{}, err
	}
	if ctx.Err() != nil || b.parent.Err() != nil {
		return hostprivacy.Response{}, time.Time{}, context.Canceled
	}
	if !value.OK || !value.Supported || value.ExpiresMs < 0 || value.ExpiresMs > 15000 || !b.worker.Alive() {
		return hostprivacy.Response{}, time.Time{}, errors.New("privacy worker unavailable")
	}
	if value.Prepared {
		if !validPrivacyIdentity(value.Identity) || value.Identity.PID != b.worker.PID() || value.Lease != b.binding.Lease || value.ExpiresMs == 0 {
			return hostprivacy.Response{}, time.Time{}, errors.New("invalid privacy worker identity")
		}
		if b.identity != nil && (value.Identity.PID != b.identity.PID || value.Identity.BirthSec != b.identity.BirthSec || value.Identity.BirthUsec != b.identity.BirthUsec || !slices.Equal(value.Identity.Windows, b.identity.Windows)) {
			return hostprivacy.Response{}, time.Time{}, errors.New("privacy worker identity changed")
		}
	} else if value.Active || value.Lease != "" || value.ExpiresMs != 0 || value.Identity != nil {
		return hostprivacy.Response{}, time.Time{}, errors.New("invalid inactive privacy worker")
	}
	return value, started.Add(time.Duration(value.ExpiresMs) * time.Millisecond), nil
}

func (b *managedPrivacy) bound(state privacyEngineState) bool {
	return state.Supported && state.Retained && state.Authorized && state.privacyBinding == b.binding && state.Epoch == b.epoch
}

func (b *managedPrivacy) ready(state privacyEngineState) bool {
	return b.bound(state) && state.Ready && state.Generation > 0 && state.FirstFrame > 0 && (b.generation == 0 || b.generation == state.Generation)
}

func (b *managedPrivacy) retire() {
	if b.binding.Lease == "" {
		return
	}
	if b.retired == nil {
		b.retired = make(map[privacyBinding]time.Time)
	}
	b.retired[b.binding] = b.now().Add(2 * time.Minute)
}

func (b *managedPrivacy) restore() error {
	b.draining = true
	if b.cancelLease != nil {
		b.cancelLease()
	}
	if b.expiry != nil {
		b.expiry.Stop()
		b.expiry = nil
	}
	b.retire()
	if b.worker != nil {
		if err := b.worker.Close(); err != nil {
			return err
		}
		b.worker = nil
	}
	if b.binding.Lease != "" {
		// The native engine independently observes the original process's death.
		// A lost release response cannot leave a local mask after Close succeeded.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _, _ = b.engineCall(ctx, &privacyEngineRequest{Op: "release", privacyBinding: b.binding})
		cancel()
	}
	b.binding, b.identity = privacyBinding{}, nil
	b.epoch, b.generation, b.deadline = 0, 0, time.Time{}
	b.draining = false
	b.leaseContext, b.cancelLease = nil, nil
	return nil
}

func (b *managedPrivacy) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	_ = b.restore()
}

func (b *managedPrivacy) activeResult() (privacyResponse, error) {
	remaining := b.deadline.Sub(b.now()).Milliseconds()
	if remaining <= 0 || remaining > 15000 {
		return privacyResponse{}, errors.New("privacy grant expired")
	}
	return privacyResponse{OK: true, Supported: true, Active: true, Lease: b.binding.Lease, ExpiresMs: remaining}, nil
}

func (b *managedPrivacy) status(ctx context.Context) (privacyResponse, error) {
	if b.draining {
		return privacyResponse{}, errors.New("privacy restoration pending")
	}
	if b.worker == nil {
		state, _, err := b.engineCall(ctx, nil)
		if errors.Is(err, errDisplayUnsupported) {
			return privacyResponse{OK: true, Code: "PRIVACY_UNSUPPORTED"}, nil
		}
		return privacyResponse{OK: err == nil, Supported: state.Supported}, err
	}
	if !b.now().Before(b.deadline) {
		return privacyResponse{}, errors.New("privacy grant expired")
	}
	state, engineDeadline, err := b.engineCall(ctx, &privacyEngineRequest{Op: "status", privacyBinding: b.binding})
	if err != nil || state.Outcome != "status" || !b.ready(state) {
		return privacyResponse{}, errors.New("privacy capture unavailable")
	}
	value, workerDeadline, err := b.workerCall(ctx, "status")
	if err != nil || !value.Active {
		return privacyResponse{}, errors.New("privacy worker inactive")
	}
	b.deadline = earlierPrivacyDeadline(b.deadline, earlierPrivacyDeadline(engineDeadline, workerDeadline))
	return b.activeResult()
}

func (b *managedPrivacy) start(ctx context.Context, binding privacyBinding) (privacyResponse, error) {
	for key, deadline := range b.retired {
		if !b.now().Before(deadline) {
			delete(b.retired, key)
		}
	}
	if _, retired := b.retired[binding]; retired {
		return privacyResponse{Code: "PRIVACY_EXPIRED"}, errors.New("retired privacy grant")
	}
	if b.worker != nil || len(b.retired) >= 128 {
		return privacyResponse{Code: "PRIVACY_BUSY"}, errors.New("privacy worker busy")
	}
	state, _, err := b.engineCall(ctx, nil)
	if errors.Is(err, errDisplayUnsupported) || (err == nil && !state.Supported) {
		return privacyResponse{Code: "PRIVACY_UNSUPPORTED"}, errors.New("privacy unsupported")
	}
	if err != nil || state.Instance != binding.Instance || state.Retained {
		return privacyResponse{}, errors.New("privacy engine unavailable")
	}
	b.binding, b.deadline = binding, b.now().Add(15*time.Second)
	b.worker, err = b.create()
	if err != nil {
		return privacyResponse{}, err
	}
	b.leaseContext, b.cancelLease = context.WithCancel(b.parent)
	if err := b.armExpiry(); err != nil {
		return privacyResponse{}, err
	}
	prepared, workerDeadline, err := b.workerCall(ctx, "prepare")
	if err != nil || !prepared.Prepared || prepared.Active {
		return privacyResponse{}, errors.New("privacy preparation unavailable")
	}
	identity := *prepared.Identity
	identity.Windows = append([]hostprivacy.Window(nil), prepared.Identity.Windows...)
	b.identity = &identity
	b.deadline = earlierPrivacyDeadline(b.deadline, workerDeadline)
	if err := b.armExpiry(); err != nil {
		return privacyResponse{}, err
	}
	state, engineDeadline, err := b.engineCall(ctx, &privacyEngineRequest{Op: "prepare", privacyBinding: binding, Worker: b.identity})
	if err != nil || state.Outcome != "accepted" {
		return privacyResponse{}, errors.New("privacy filter not accepted")
	}
	b.epoch = state.Epoch
	if !b.bound(state) {
		return privacyResponse{}, errors.New("privacy filter binding mismatch")
	}
	b.deadline = earlierPrivacyDeadline(b.deadline, engineDeadline)
	if err := b.armExpiry(); err != nil {
		return privacyResponse{}, err
	}
	for {
		if !b.now().Before(b.deadline) || !b.worker.Alive() {
			return privacyResponse{}, errors.New("privacy preparation expired")
		}
		state, engineDeadline, err = b.engineCall(ctx, &privacyEngineRequest{Op: "status", privacyBinding: binding})
		if err != nil || state.Outcome != "status" || !b.bound(state) {
			return privacyResponse{}, errors.New("privacy filter withdrawn")
		}
		b.deadline = earlierPrivacyDeadline(b.deadline, engineDeadline)
		if b.ready(state) {
			b.generation = state.Generation
			break
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return privacyResponse{}, ctx.Err()
		case <-timer.C:
		}
	}
	active, workerDeadline, err := b.workerCall(ctx, "activate")
	if err != nil || !active.Active {
		return privacyResponse{}, errors.New("privacy activation unavailable")
	}
	b.deadline = earlierPrivacyDeadline(b.deadline, workerDeadline)
	// Check the encoded generation again after showing the actual native mask.
	result, err := b.status(ctx)
	if err == nil {
		err = b.armExpiry()
	}
	return result, err
}

func (b *managedPrivacy) renew(ctx context.Context) (privacyResponse, error) {
	if b.draining {
		return privacyResponse{}, errors.New("privacy restoration pending")
	}
	if _, err := b.status(ctx); err != nil {
		return privacyResponse{}, err
	}
	priorDeadline := b.deadline
	state, engineDeadline, err := b.engineCall(ctx, &privacyEngineRequest{Op: "renew", privacyBinding: b.binding})
	if err != nil || state.Outcome != "renewed" || !b.ready(state) {
		return privacyResponse{}, errors.New("privacy filter renewal refused")
	}
	value, workerDeadline, err := b.workerCall(ctx, "renew")
	if err != nil || !value.Active || !b.now().Before(priorDeadline) {
		return privacyResponse{}, errors.New("late privacy renewal")
	}
	b.deadline = earlierPrivacyDeadline(engineDeadline, workerDeadline)
	result, err := b.status(ctx)
	if !b.now().Before(priorDeadline) {
		return privacyResponse{}, errors.New("late privacy acknowledgement")
	}
	if err == nil {
		err = b.armExpiry()
	}
	return result, err
}

func (b *managedPrivacy) handle(parent context.Context, op string, request privacyRequest, owner string) (value privacyResponse, result error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	binding := privacyBinding{request.Instance, owner, request.Stream, request.Lease}
	if op == "stop" {
		if b.binding.Lease != "" && binding != b.binding {
			return privacyResponse{}, errors.New("foreign privacy stop")
		}
		err := b.restore()
		return privacyResponse{OK: err == nil, Supported: true}, err
	}
	if b.closed {
		return privacyResponse{}, errors.New("privacy owner closed")
	}
	if b.parent.Err() != nil {
		_ = b.restore()
		return privacyResponse{}, b.parent.Err()
	}
	// A rejected old request must never stop a different current lease.
	if op != "status" && !validPrivacyBinding(binding) {
		return privacyResponse{}, errors.New("invalid privacy binding")
	}
	if op == "start" && b.worker != nil {
		return privacyResponse{Code: "PRIVACY_BUSY"}, errors.New("privacy worker busy")
	}
	if op == "renew" && (b.worker == nil || binding != b.binding) {
		return privacyResponse{}, errors.New("expired privacy binding")
	}
	if op != "status" && op != "start" && op != "renew" {
		return privacyResponse{}, errors.New("invalid privacy operation")
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	stop := context.AfterFunc(b.parent, cancel)
	defer func() { stop(); cancel() }()
	defer func() {
		if result == nil && b.parent.Err() != nil {
			result = b.parent.Err()
			value = privacyResponse{}
		}
		if result == nil && ctx.Err() != nil {
			result = ctx.Err()
			value = privacyResponse{}
		}
		if result != nil {
			_ = b.restore()
		}
	}()
	if ctx.Err() != nil {
		return privacyResponse{}, ctx.Err()
	}
	switch op {
	case "status":
		value, err := b.status(ctx)
		if err == nil && b.worker != nil {
			err = b.armExpiry()
		}
		return value, err
	case "start":
		return b.start(ctx, binding)
	case "renew":
		return b.renew(ctx)
	default:
		return privacyResponse{}, errors.New("invalid privacy operation")
	}
}
