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

// A privacy screen is host-wide. Only the sole, currently streaming paired
// client can acquire it. Both this service and the desktop worker expire it.
type privacyRequest struct {
	Op       string `json:"op"`
	Instance string `json:"instance,omitempty"`
	Stream   uint64 `json:"stream,omitempty"`
	Lease    string `json:"lease,omitempty"`
}
type privacyResponse struct {
	OK        bool   `json:"ok"`
	Code      string `json:"code,omitempty"`
	Supported bool   `json:"supported"`
	Active    bool   `json:"active"`
	Lease     string `json:"lease,omitempty"`
	ExpiresMs int64  `json:"expiresMs"`
}
type privacyControl struct {
	mu          sync.Mutex
	clients     string
	provider    displayProvider
	read        func(string) (json.RawMessage, error)
	now         func() time.Time
	request     privacyRequest
	certificate []byte
	owner       string
	deadline    time.Time
}

func (p *privacyControl) worker(op, lease string) (privacyResponse, error) {
	command, _ := json.Marshal(struct {
		Op    string `json:"op"`
		Lease string `json:"lease,omitempty"`
	}{op, lease})
	raw, err := p.read("privacy:" + string(command))
	var response privacyResponse
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &response) != nil {
		return response, errors.New("privacy worker unavailable")
	}
	if response.OK && (response.ExpiresMs < 0 || response.ExpiresMs > 15000 || (response.Active && (!response.Supported || !fileID.MatchString(response.Lease) || response.ExpiresMs == 0))) {
		return privacyResponse{}, errors.New("invalid privacy worker state")
	}
	if response.OK && !response.Active && (response.Lease != "" || response.ExpiresMs != 0) {
		return privacyResponse{}, errors.New("invalid inactive privacy worker state")
	}
	return response, nil
}
func (p *privacyControl) restore() {
	if p.request.Lease != "" {
		_, _ = p.worker("stop", p.request.Lease)
	}
	p.request = privacyRequest{}
	p.certificate = nil
	p.owner = ""
	p.deadline = time.Time{}
}
func (p *privacyControl) bound(ctx context.Context, request privacyRequest, owner string) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	state, err := p.provider(ctx, false, nil)
	return err == nil && validDisplayState(state) && state.Instance == request.Instance && state.Phase == "active" && len(state.Streams) == 1 &&
		state.Streams[0].Owner == owner && state.Streams[0].ID == request.Stream && state.Streams[0].Generation == state.Generation && state.Streams[0].FirstFrame > 0
}
func (p *privacyControl) maintain(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	defer func() { p.mu.Lock(); defer p.mu.Unlock(); p.restore() }()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			p.check(ctx)
		}
	}
}
func (p *privacyControl) check(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.request.Lease != "" && (!p.now().Before(p.deadline) || !paired(p.clients, p.certificate) || !p.bound(ctx, p.request, p.owner)) {
		p.restore()
	}
}

func (p *privacyControl) handler(next http.Handler) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/privacy" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value privacyResponse) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, privacyResponse{Code: code}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(p.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "PRIVACY_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "PRIVACY_BAD_REQUEST")
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			fail(429, "PRIVACY_BUSY")
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		var request privacyRequest
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			fail(400, "PRIVACY_BAD_REQUEST")
			return
		}
		if request.Op == "status" {
			if request.Instance != "" || request.Stream != 0 || request.Lease != "" {
				fail(400, "PRIVACY_BAD_REQUEST")
				return
			}
		} else if (request.Op != "start" && request.Op != "renew" && request.Op != "stop") || !displayInstance.MatchString(request.Instance) || request.Stream == 0 || !fileID.MatchString(request.Lease) {
			fail(400, "PRIVACY_BAD_REQUEST")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(digest[:])
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.request.Lease != "" && !p.now().Before(p.deadline) {
			p.restore()
		}
		if !allowed() {
			fail(403, "PRIVACY_UNPAIRED")
			return
		}
		if request.Op == "status" {
			value, err := p.worker("status", "")
			if !allowed() {
				if p.owner == owner {
					p.restore()
				}
				fail(403, "PRIVACY_UNPAIRED")
				return
			}
			if err != nil {
				fail(503, "PRIVACY_UNAVAILABLE")
				return
			}
			// No other client's lease identifier or active state is disclosed.
			if p.owner != owner || value.Lease != p.request.Lease {
				value.Active = false
				value.Lease = ""
				value.ExpiresMs = 0
			}
			reply(200, value)
			return
		}
		matching := p.owner == owner && p.request.Instance == request.Instance && p.request.Stream == request.Stream && p.request.Lease == request.Lease
		if p.request.Lease != "" && !matching {
			fail(409, "PRIVACY_BUSY")
			return
		}
		if request.Op == "stop" {
			if matching {
				p.restore()
			}
			reply(200, privacyResponse{OK: true})
			return
		}
		if request.Op == "renew" && !matching {
			fail(409, "PRIVACY_EXPIRED")
			return
		}
		if !p.bound(r.Context(), request, owner) || !allowed() {
			if matching {
				p.restore()
			}
			fail(409, "PRIVACY_NO_EXCLUSIVE_STREAM")
			return
		}
		op := "start"
		if matching {
			op = "renew"
		}
		// Store before invoking the worker: a lost acknowledgment must still be
		// restored. The worker never renews itself or reacquires an expired lease.
		p.request = request
		p.owner = owner
		p.certificate = append([]byte(nil), r.TLS.PeerCertificates[0].Raw...)
		p.deadline = p.now().Add(15 * time.Second)
		value, err := p.worker(op, request.Lease)
		if err != nil || !value.OK || !value.Active || value.Lease != request.Lease || !allowed() {
			p.restore()
			code := "PRIVACY_UNAVAILABLE"
			if err == nil {
				switch value.Code {
				case "PRIVACY_UNSUPPORTED", "PRIVACY_DESKTOP_UNAVAILABLE", "PRIVACY_EXPIRED", "PRIVACY_BUSY":
					code = value.Code
				}
			}
			fail(409, code)
			return
		}
		reply(200, value)
	})
}
