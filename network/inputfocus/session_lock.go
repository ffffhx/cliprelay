package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

type sessionLockState struct {
	OK              bool   `json:"ok"`
	Supported       bool   `json:"supported"`
	State           string `json:"state"`
	Lease           string `json:"lease,omitempty"`
	ExpiresMs       int64  `json:"expiresMs"`
	Code            string `json:"code,omitempty"`
	Instance        string `json:"instance,omitempty"`
	Stream          uint64 `json:"stream,omitempty"`
	CancelProtected bool   `json:"cancelProtected"`
}

type sessionLockControl struct {
	mu                             sync.Mutex
	clients                        string
	provider                       displayProvider
	read                           func(string) (json.RawMessage, error)
	cleanupRead                    func(string) (json.RawMessage, error)
	now                            func() time.Time
	request                        privacyRequest
	certificate                    []byte
	owner                          string
	deadline, lastRenew, idleSince time.Time
	result                         sessionLockState
	cancelling                     bool
	retired                        map[string]time.Time
}

func (p *sessionLockControl) worker(op, lease string) (sessionLockState, error) {
	command, _ := json.Marshal(struct {
		Op    string `json:"op"`
		Lease string `json:"lease,omitempty"`
	}{op, lease})
	read := p.read
	if op == "cancel" && p.cleanupRead != nil {
		read = p.cleanupRead
	}
	raw, err := read("session-lock:" + string(command))
	var state sessionLockState
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &state) != nil {
		return state, errors.New("lock worker unavailable")
	}
	if !state.OK {
		return state, nil
	}
	if state.ExpiresMs < 0 || state.ExpiresMs > 15000 {
		return state, errors.New("invalid lock expiry")
	}
	switch state.State {
	case "off":
		if state.Lease != "" || state.ExpiresMs != 0 {
			return state, errors.New("invalid off state")
		}
	case "armed", "requested":
		if !state.Supported || !fileID.MatchString(state.Lease) || state.ExpiresMs == 0 {
			return state, errors.New("invalid armed state")
		}
	case "locked", "failed", "cancelled":
		if !fileID.MatchString(state.Lease) || state.ExpiresMs != 0 {
			return state, errors.New("invalid final state")
		}
	default:
		return state, errors.New("unknown lock state")
	}
	return state, nil
}
func (p *sessionLockControl) retire(owner, lease string) bool {
	if p.retired == nil {
		p.retired = make(map[string]time.Time)
	}
	now := p.now()
	active := p.owner + ":" + p.request.Lease
	for key, until := range p.retired {
		if key != active && !now.Before(until) {
			delete(p.retired, key)
		}
	}
	key := owner + ":" + lease
	if _, exists := p.retired[key]; !exists && len(p.retired) >= 256 {
		return false
	}
	// An active intent reserves its slot too: unrelated cancellation receipts
	// cannot fill the table and prevent us remembering its later cancellation.
	p.retired[key] = now.Add(2 * time.Minute)
	return true
}

func (p *sessionLockControl) forget() {
	p.request = privacyRequest{}
	p.certificate = nil
	p.owner = ""
	p.deadline = time.Time{}
	p.idleSince = time.Time{}
	p.result = sessionLockState{}
	p.cancelling = false
}

func (p *sessionLockControl) clear() bool {
	if p.request.Lease == "" {
		p.forget()
		return true
	}
	p.cancelling = true
	p.retire(p.owner, p.request.Lease)
	value, err := p.worker("cancel", p.request.Lease)
	if err == nil && value.OK && value.State == "off" {
		p.forget()
		return true
	}
	if err == nil && value.Code == "LOCK_ALREADY_REQUESTED" {
		// A lost commit reply can leave result=failed although the worker has
		// already asked Windows to lock. Never turn that into a successful cancel.
		p.cancelling = false
		p.result = sessionLockState{OK: true, Supported: true, State: "requested", Lease: p.request.Lease, ExpiresMs: 5000}
		p.deadline = p.now().Add(5 * time.Second)
	}
	return false
}
func (p *sessionLockControl) engine(ctx context.Context) (displayState, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	state, err := p.provider(ctx, false, nil)
	if err == nil && !validDisplayState(state) {
		err = errors.New("invalid engine state")
	}
	return state, err
}
func sameLockStream(state displayState, request privacyRequest, owner string) bool {
	return state.Instance == request.Instance && len(state.Streams) == 1 && state.Streams[0].ID == request.Stream && state.Streams[0].Owner == owner
}
func (p *sessionLockControl) maintain(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	defer func() { p.mu.Lock(); defer p.mu.Unlock(); p.clear() }()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			p.check(ctx)
		}
	}
}
func (p *sessionLockControl) check(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.checkLocked(ctx)
}
func (p *sessionLockControl) checkLocked(ctx context.Context) {
	if p.request.Lease == "" {
		return
	}
	if !paired(p.clients, p.certificate) {
		p.clear()
		return
	}
	if p.cancelling {
		p.clear()
		return
	}
	if p.result.State == "requested" {
		state, err := p.worker("status", "")
		if err == nil && state.OK && state.Lease == p.request.Lease && (state.State == "requested" || state.State == "locked" || state.State == "failed") {
			p.result = state
		}
		if !p.now().Before(p.deadline) && p.result.State == "requested" {
			p.result.State = "failed"
			p.result.ExpiresMs = 0
		}
		return
	}
	if p.result.State == "locked" || p.result.State == "failed" {
		if p.now().Sub(p.deadline) > 2*time.Minute {
			p.clear()
		}
		return
	}
	if !p.now().Before(p.deadline) {
		p.clear()
		return
	}
	state, err := p.engine(ctx)
	if err != nil {
		p.idleSince = time.Time{}
		return
	} // uncertain state never locks or renews
	if state.Instance != p.request.Instance {
		p.clear()
		return
	}
	if len(state.Streams) > 0 {
		p.idleSince = time.Time{}
		// Any replacement or additional stream cancels this host-wide intent.
		if !sameLockStream(state, p.request, p.owner) {
			p.clear()
			return
		}
		if p.now().Sub(p.lastRenew) >= 4*time.Second {
			started := p.now()
			value, err := p.worker("renew", p.request.Lease)
			if err != nil || !value.OK || value.State != "armed" || value.Lease != p.request.Lease || !paired(p.clients, p.certificate) {
				p.clear()
				return
			}
			p.lastRenew = started
			p.deadline = started.Add(time.Duration(value.ExpiresMs) * time.Millisecond)
			p.result = value
		}
		return
	}
	if state.Phase != "idle" {
		p.idleSince = time.Time{}
		return
	}
	if p.idleSince.IsZero() {
		p.idleSince = p.now()
		return
	}
	if p.now().Sub(p.idleSince) < 1500*time.Millisecond {
		return
	}
	// Recheck immediately before consuming the one-shot intent. There must be
	// no stream of any owner and no engine restart, not merely a stale phone.
	state, err = p.engine(ctx)
	if err != nil || state.Instance != p.request.Instance || state.Phase != "idle" || len(state.Streams) != 0 || !paired(p.clients, p.certificate) {
		p.idleSince = time.Time{}
		return
	}
	value, err := p.worker("commit", p.request.Lease)
	if err != nil || !value.OK || value.Lease != p.request.Lease || (value.State != "requested" && value.State != "locked" && value.State != "failed") {
		// A lost acknowledgment may mean Windows already accepted the request.
		// Consume it locally too; never send commit a second time.
		p.result = sessionLockState{OK: true, Supported: true, State: "failed", Lease: p.request.Lease}
		return
	}
	p.result = value
	p.deadline = p.now().Add(5 * time.Second)
}

func (p *sessionLockControl) handler(next http.Handler) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/session-lock" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value sessionLockState) {
			value.CancelProtected = true
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, sessionLockState{Code: code}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(p.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "LOCK_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "LOCK_BAD_REQUEST")
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			fail(429, "LOCK_BUSY")
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		var request privacyRequest
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			fail(400, "LOCK_BAD_REQUEST")
			return
		}
		if request.Op == "status" {
			if request.Instance != "" || request.Stream != 0 || request.Lease != "" {
				fail(400, "LOCK_BAD_REQUEST")
				return
			}
		} else if (request.Op != "arm" && request.Op != "disarm") || !displayInstance.MatchString(request.Instance) || request.Stream == 0 || !fileID.MatchString(request.Lease) {
			fail(400, "LOCK_BAD_REQUEST")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(digest[:])
		p.mu.Lock()
		defer p.mu.Unlock()
		if !allowed() {
			fail(403, "LOCK_UNPAIRED")
			return
		}
		p.checkLocked(r.Context())
		if request.Op == "status" {
			if p.cancelling {
				fail(503, "LOCK_CANCEL_PENDING")
				return
			}
			state, err := p.worker("status", "")
			if !allowed() {
				if p.owner == owner {
					p.clear()
				}
				fail(403, "LOCK_UNPAIRED")
				return
			}
			if err != nil || !state.OK {
				fail(503, "LOCK_UNAVAILABLE")
				return
			}
			if state.State == "off" && p.owner == owner && p.request.Lease != "" {
				// Worker restart or expiry is authoritative: retire the old intent
				// instead of renewing it after telling the client it is off.
				p.retire(owner, p.request.Lease)
				p.forget()
			}
			if p.owner != owner || state.Lease != p.request.Lease {
				reply(200, sessionLockState{OK: true, Supported: state.Supported, State: "off"})
				return
			}
			state.Instance = p.request.Instance
			state.Stream = p.request.Stream
			reply(200, state)
			return
		}
		matching := p.owner == owner && request.Instance == p.request.Instance && request.Stream == p.request.Stream && request.Lease == p.request.Lease
		if p.request.Lease != "" && !matching {
			if p.result.State == "locked" || p.result.State == "failed" {
				if !p.clear() {
					fail(409, "LOCK_BUSY")
					return
				}
			} else {
				fail(409, "LOCK_BUSY")
				return
			}
		}
		if request.Op == "disarm" {
			if !p.retire(owner, request.Lease) {
				fail(429, "LOCK_BUSY")
				return
			}
			if matching && p.result.State == "requested" {
				fail(409, "LOCK_ALREADY_REQUESTED")
				return
			}
			if matching {
				if !p.clear() {
					if p.result.State == "requested" {
						fail(409, "LOCK_ALREADY_REQUESTED")
					} else {
						fail(503, "LOCK_CANCEL_PENDING")
					}
					return
				}
			}
			reply(200, sessionLockState{OK: true, Supported: true, State: "off"})
			return
		}
		if p.cancelling {
			fail(503, "LOCK_CANCEL_PENDING")
			return
		}
		if until, found := p.retired[owner+":"+request.Lease]; found && !matching && p.now().Before(until) {
			fail(409, "LOCK_EXPIRED")
			return
		}
		if matching && p.result.State != "armed" {
			fail(409, "LOCK_EXPIRED")
			return
		}
		state, err := p.engine(r.Context())
		if err != nil || !sameLockStream(state, request, owner) || state.Phase != "active" || state.Streams[0].FirstFrame == 0 || state.Streams[0].Generation != state.Generation || !allowed() {
			fail(409, "LOCK_NO_EXCLUSIVE_STREAM")
			return
		}
		op := "arm"
		if matching {
			op = "renew"
		} else if !p.retire(owner, request.Lease) {
			fail(429, "LOCK_BUSY")
			return
		}
		p.request = request
		p.owner = owner
		p.certificate = append([]byte(nil), r.TLS.PeerCertificates[0].Raw...)
		p.lastRenew = p.now()
		value, err := p.worker(op, request.Lease)
		if err != nil || !value.OK || value.State != "armed" || value.Lease != request.Lease || !allowed() {
			p.clear()
			fail(409, "LOCK_UNAVAILABLE")
			return
		}
		p.deadline = p.lastRenew.Add(time.Duration(value.ExpiresMs) * time.Millisecond)
		p.result = value
		p.idleSince = time.Time{}
		value.Instance = request.Instance
		value.Stream = request.Stream
		reply(200, value)
	})
}
