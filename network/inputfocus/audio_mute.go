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

type audioMuteRequest struct {
	privacyRequest
	AudioGeneration uint64 `json:"audioGeneration,omitempty"`
}
type audioMuteState struct {
	privacyResponse
	Recovering bool `json:"recovering"`
	Outputs    int  `json:"outputs"`
}

// Mute is permitted only while the sole paired stream has fresh, encoded
// process-loopback or Mac system-tap audio. Endpoint capture is never sufficient.
type audioMuteControl struct {
	mu          sync.Mutex
	clients     string
	provider    displayProvider
	read        func(string) (json.RawMessage, error)
	cleanupRead func(string) (json.RawMessage, error)
	now         func() time.Time
	request     audioMuteRequest
	certificate []byte
	owner       string
	deadline    time.Time
	restoring   bool
	retired     map[string]time.Time
}

func (p *audioMuteControl) worker(op, lease string) (audioMuteState, error) {
	command, _ := json.Marshal(struct {
		Op    string `json:"op"`
		Lease string `json:"lease,omitempty"`
	}{op, lease})
	read := p.read
	if op == "stop" && p.cleanupRead != nil {
		read = p.cleanupRead
	}
	raw, err := read("audio-mute:" + string(command))
	var value audioMuteState
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &value) != nil {
		return value, errors.New("audio worker unavailable")
	}
	if value.ExpiresMs < 0 || value.ExpiresMs > 15000 || value.Outputs < 0 || value.Outputs > 32 || len(value.Code) > 64 ||
		(value.Supported && value.Outputs == 0) || (value.Active && (!value.Supported || value.Recovering || !fileID.MatchString(value.Lease) || value.ExpiresMs == 0)) ||
		(!value.Active && (value.Lease != "" || value.ExpiresMs != 0)) || (value.Recovering && value.Supported) {
		return audioMuteState{}, errors.New("invalid audio worker state")
	}
	return value, nil
}
func (p *audioMuteControl) bound(ctx context.Context, request audioMuteRequest, owner string) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	state, err := p.provider(ctx, false, nil)
	if err != nil || !validDisplayState(state) || state.Instance != request.Instance || state.Phase != "active" || len(state.Streams) != 1 {
		return false
	}
	stream := state.Streams[0]
	return stream.Owner == owner && stream.ID == request.Stream && stream.Generation == state.Generation && stream.FirstFrame > 0 &&
		stream.Audio != nil && safeMuteCapture(stream.Audio.Capture) && stream.Audio.Ready && stream.Audio.Generation == request.AudioGeneration && request.AudioGeneration > 0
}
func safeMuteCapture(kind string) bool { return kind == "process" || kind == "system-tap" }
func (p *audioMuteControl) retire(owner, lease string) bool {
	if p.retired == nil {
		p.retired = make(map[string]time.Time)
	}
	now := p.now()
	for key, until := range p.retired {
		if !now.Before(until) {
			delete(p.retired, key)
		}
	}
	key := owner + ":" + lease
	if _, exists := p.retired[key]; !exists && len(p.retired) >= 256 {
		return false
	}
	// The server bounds request reads and rejects concurrent operations. Keep
	// canceled tokens beyond that window so late start/retry cannot undo stop.
	p.retired[key] = now.Add(2 * time.Minute)
	return true
}
func (p *audioMuteControl) restore() bool {
	if p.request.Lease == "" {
		return true
	}
	p.restoring = true
	p.retire(p.owner, p.request.Lease)
	state, err := p.worker("stop", p.request.Lease)
	if err != nil || !state.OK || state.Active || state.Recovering {
		return false
	}
	p.request = audioMuteRequest{}
	p.certificate = nil
	p.owner = ""
	p.deadline = time.Time{}
	p.restoring = false
	return true
}
func (p *audioMuteControl) checkLocked(ctx context.Context) {
	if p.request.Lease == "" {
		return
	}
	if p.restoring || !p.now().Before(p.deadline) || !paired(p.clients, p.certificate) || !p.bound(ctx, p.request, p.owner) {
		p.restore()
		return
	}
	value, err := p.worker("status", "")
	if err != nil || !value.OK || !value.Active || value.Lease != p.request.Lease {
		p.restore()
	}
}
func (p *audioMuteControl) check(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.checkLocked(ctx)
}
func (p *audioMuteControl) maintain(ctx context.Context) {
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	defer func() { p.mu.Lock(); defer p.mu.Unlock(); p.restore() }()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			p.check(ctx)
		}
	}
}

func (p *audioMuteControl) handler(next http.Handler) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio-mute" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value audioMuteState) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) {
			reply(status, audioMuteState{privacyResponse: privacyResponse{Code: code}})
		}
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(p.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "AUDIO_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "AUDIO_BAD_REQUEST")
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			fail(429, "AUDIO_BUSY")
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Second))
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		var request audioMuteRequest
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			fail(400, "AUDIO_BAD_REQUEST")
			return
		}
		if request.Op == "status" {
			if request.Instance != "" || request.Stream != 0 || request.Lease != "" || request.AudioGeneration != 0 {
				fail(400, "AUDIO_BAD_REQUEST")
				return
			}
		} else if (request.Op != "start" && request.Op != "renew" && request.Op != "stop") || !displayInstance.MatchString(request.Instance) || request.Stream == 0 || !fileID.MatchString(request.Lease) || request.AudioGeneration == 0 {
			fail(400, "AUDIO_BAD_REQUEST")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(digest[:])
		p.mu.Lock()
		defer p.mu.Unlock()
		p.checkLocked(r.Context())
		if !allowed() {
			fail(403, "AUDIO_UNPAIRED")
			return
		}
		if request.Op == "status" {
			value, err := p.worker("status", "")
			if !allowed() {
				if p.owner == owner {
					p.restore()
				}
				fail(403, "AUDIO_UNPAIRED")
				return
			}
			if err != nil {
				fail(503, "AUDIO_UNAVAILABLE")
				return
			}
			if p.owner != owner || value.Lease != p.request.Lease || p.restoring {
				value.Active = false
				value.Lease = ""
				value.ExpiresMs = 0
			}
			// Capability is stream-specific, including before the first start.
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			state, stateErr := p.provider(ctx, false, nil)
			cancel()
			ready := false
			if stateErr == nil && validDisplayState(state) && state.Phase == "active" && len(state.Streams) == 1 {
				s := state.Streams[0]
				ready = s.Owner == owner && s.Generation == state.Generation && s.FirstFrame > 0 && s.Audio != nil && safeMuteCapture(s.Audio.Capture) && s.Audio.Ready
			}
			value.Supported = value.Supported && ready && !p.restoring
			value.Recovering = value.Recovering || p.restoring
			if !allowed() {
				if p.owner == owner {
					p.restore()
				}
				fail(403, "AUDIO_UNPAIRED")
				return
			}
			if value.Active && !value.Supported {
				p.restore()
				value.Active = false
				value.Lease = ""
				value.ExpiresMs = 0
			}
			reply(200, value)
			return
		}
		matching := p.owner == owner && p.request.Instance == request.Instance && p.request.Stream == request.Stream && p.request.AudioGeneration == request.AudioGeneration && p.request.Lease == request.Lease
		if p.request.Lease != "" && !matching {
			fail(409, "AUDIO_BUSY")
			return
		}
		if request.Op == "stop" {
			if !p.retire(owner, request.Lease) {
				fail(429, "AUDIO_BUSY")
				return
			}
			if matching && !p.restore() {
				fail(503, "AUDIO_RECOVERY_PENDING")
				return
			}
			reply(200, audioMuteState{privacyResponse: privacyResponse{OK: true}})
			return
		}
		if p.restoring {
			fail(409, "AUDIO_RECOVERY_PENDING")
			return
		}
		if until, found := p.retired[owner+":"+request.Lease]; found && p.now().Before(until) {
			fail(409, "AUDIO_EXPIRED")
			return
		}
		if request.Op == "renew" && !matching {
			fail(409, "AUDIO_EXPIRED")
			return
		}
		if !p.bound(r.Context(), request, owner) || !allowed() {
			if matching {
				p.restore()
			}
			fail(409, "AUDIO_NO_SAFE_STREAM")
			return
		}
		if !matching {
			// Reserve a retirement entry before changing sound. Capacity limits
			// cannot later prevent remembering a canceled token.
			if !p.retire(owner, request.Lease) {
				fail(429, "AUDIO_BUSY")
				return
			}
			delete(p.retired, owner+":"+request.Lease)
		}
		op := "start"
		if matching {
			op = "renew"
		}
		p.request = request
		p.owner = owner
		p.certificate = append([]byte(nil), r.TLS.PeerCertificates[0].Raw...)
		p.deadline = p.now().Add(15 * time.Second)
		value, err := p.worker(op, request.Lease)
		if err != nil || !value.OK || !value.Active || value.Lease != request.Lease || !allowed() || !p.bound(r.Context(), request, owner) || !allowed() {
			p.restore()
			fail(409, "AUDIO_UNAVAILABLE")
			return
		}
		reply(200, value)
	})
}
