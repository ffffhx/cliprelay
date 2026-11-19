package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
)

type herdrRequest struct {
	Op          string   `json:"op"`
	Instance    string   `json:"instance,omitempty"`
	ID          string   `json:"id,omitempty"`
	CoreSession string   `json:"coreSession,omitempty"`
	Terminal    string   `json:"terminal,omitempty"`
	CoreID      string   `json:"coreId,omitempty"`
	CreatedMS   *int64   `json:"createdMs,omitempty"`
	Project     string   `json:"project,omitempty"`
	Agent       string   `json:"agent,omitempty"`
	Name        string   `json:"name,omitempty"`
	Query       string   `json:"query,omitempty"`
	After       *int64   `json:"after,omitempty"`
	Sequence    *int64   `json:"sequence,omitempty"`
	Text        string   `json:"text,omitempty"`
	Keys        []string `json:"keys,omitempty"`
}
type herdrReply struct {
	OK       bool            `json:"ok"`
	Code     string          `json:"code,omitempty"`
	Instance string          `json:"instance"`
	Result   json.RawMessage `json:"result,omitempty"`
}
type herdrControl struct {
	clients           string
	read, cleanupRead func(string) (json.RawMessage, error)
	mu                sync.Mutex
	started           bool
	unsupported       bool
}

func (h *herdrControl) syncLocked(stop bool) error {
	owners, err := terminalOwners(h.clients)
	if stop || err != nil {
		owners = []string{}
	}
	payload, _ := json.Marshal(struct {
		Op     string   `json:"op"`
		Owners []string `json:"owners"`
	}{"sync", owners})
	read := h.read
	if stop && h.cleanupRead != nil {
		read = h.cleanupRead
	}
	h.started = true
	raw, readErr := read(string(payload))
	var reply herdrReply
	if readErr != nil || len(raw) > 1024*1024 || json.Unmarshal(raw, &reply) != nil || !reply.OK || !fileID.MatchString(reply.Instance) {
		return errors.New("herdr authorization unavailable")
	}
	return err
}
func (h *herdrControl) maintain(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			if h.started {
				_ = h.syncLocked(true)
			}
			h.mu.Unlock()
			return
		case <-tick.C:
			h.mu.Lock()
			if h.started {
				_ = h.syncLocked(false)
			}
			h.mu.Unlock()
		}
	}
}
func validHerdrSession(name string) bool {
	return name != "" && len(name) <= 240 && name == strings.TrimSpace(name) && name != "." && name != ".." && !strings.ContainsAny(name, "/\\:*?\"<>|") && strings.IndexFunc(name, unicode.IsControl) < 0
}
func validHerdrRequest(r herdrRequest) bool {
	base := r.After == nil && r.Sequence == nil && r.Text == "" && r.Keys == nil
	if r.Op == "agents" {
		return base && r.Instance == "" && r.ID == "" && r.CoreSession == "" && r.CoreID == "" && r.CreatedMS == nil && r.Terminal == "" && r.Project == "" && r.Agent == "" && r.Name == "" && len([]rune(r.Query)) <= 80 && strings.IndexFunc(r.Query, unicode.IsControl) < 0
	}
	if r.Query != "" {
		return false
	}
	if r.Op == "close" {
		return base && fileID.MatchString(r.Instance) && fileID.MatchString(r.ID) && validHerdrSession(r.CoreSession) && len(r.CoreID) > 0 && len(r.CoreID) <= 128 && strings.IndexFunc(r.CoreID, unicode.IsControl) < 0 && r.CreatedMS != nil && *r.CreatedMS > 0 && *r.CreatedMS < 1<<53 && validHerdrTerminalAddress(r.Terminal) && r.Project == "" && r.Agent == "" && r.Name == ""
	}
	if r.CoreID != "" || r.CreatedMS != nil {
		return false
	}
	if r.Op == "create" {
		return r.Instance == "" && fileID.MatchString(r.ID) && validHerdrSession(r.CoreSession) && r.Terminal == "" && base && len(r.Project) > 0 && len(r.Project) <= 128 && strings.IndexFunc(r.Project, unicode.IsControl) < 0 && validHerdrAgentID(r.Agent) && len(r.Name) <= 320 && len([]rune(r.Name)) <= 80 && strings.IndexFunc(r.Name, unicode.IsControl) < 0
	}
	if r.Project != "" || r.Agent != "" || r.Name != "" {
		return false
	}
	if r.Op == "list" {
		return r.Instance == "" && r.ID == "" && r.Terminal == "" && base && (r.CoreSession == "" || validHerdrSession(r.CoreSession))
	}
	if !fileID.MatchString(r.Instance) || !fileID.MatchString(r.ID) {
		return false
	}
	if r.Op == "watch" {
		return base && validHerdrSession(r.CoreSession) && len(r.Terminal) > 0 && len(r.Terminal) <= 768 && strings.IndexFunc(r.Terminal, unicode.IsControl) < 0
	}
	if r.CoreSession != "" || r.Terminal != "" {
		return false
	}
	if r.Op == "detach" {
		return base
	}
	if r.Op == "read" {
		return r.After != nil && *r.After >= 0 && *r.After < 1<<53 && r.Sequence == nil && r.Text == "" && r.Keys == nil
	}
	if r.After != nil || r.Sequence == nil || *r.Sequence < 1 || *r.Sequence >= 1<<53 {
		return false
	}
	if r.Op == "send" {
		return r.Keys == nil && len(r.Text) > 0 && len(r.Text) <= 16384 && strings.IndexFunc(r.Text, func(c rune) bool { return unicode.IsControl(c) && c != '\r' && c != '\n' && c != '\t' }) < 0
	}
	if r.Op == "keys" {
		if r.Text != "" || len(r.Keys) < 1 || len(r.Keys) > 16 {
			return false
		}
		for _, key := range r.Keys {
			if key == "shift+left" {
				continue
			}
			if len(key) < 1 || len(key) > 16 || strings.IndexFunc(key, func(c rune) bool { return c < 'a' || c > 'z' }) >= 0 && !(len(key) == 1 && key[0] >= '0' && key[0] <= '9') && !(len(key) == 6 && strings.HasPrefix(key, "ctrl+") && key[5] >= 'a' && key[5] <= 'z') {
				return false
			}
		}
		return true
	}
	return false
}
func validHerdrAgentID(id string) bool {
	if len(id) < 1 || len(id) > 128 {
		return false
	}
	for i, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '.' || c == '_' || c == '-')) {
			return false
		}
	}
	return true
}
func validHerdrTerminalAddress(address string) bool {
	return len(address) > 1 && len(address) <= 64 && address[0] == 't' && strings.IndexFunc(address[1:], func(c rune) bool { return !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z') }) < 0
}
func (h *herdrControl) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/herdr" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value herdrReply) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, herdrReply{Code: code}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(h.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "HERDR_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "HERDR_BAD_REQUEST")
			return
		}
		if h.unsupported {
			fail(501, "HERDR_UNSUPPORTED")
			return
		}
		var request herdrRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !validHerdrRequest(request) {
			fail(400, "HERDR_BAD_REQUEST")
			return
		}
		if !h.mu.TryLock() {
			fail(429, "HERDR_BUSY")
			return
		}
		defer h.mu.Unlock()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(30 * time.Second))
		if !allowed() {
			fail(403, "HERDR_UNPAIRED")
			return
		}
		if h.syncLocked(false) != nil {
			fail(503, "HERDR_UNAVAILABLE")
			return
		}
		if !allowed() {
			_ = h.syncLocked(false)
			fail(403, "HERDR_UNPAIRED")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		payload, _ := json.Marshal(struct {
			herdrRequest
			Owner string `json:"owner"`
		}{request, hex.EncodeToString(digest[:])})
		raw, err := h.read(string(payload))
		var result herdrReply
		if !allowed() {
			_ = h.syncLocked(false)
			fail(403, "HERDR_UNPAIRED")
			return
		}
		if err != nil || len(raw) > 1024*1024 || json.Unmarshal(raw, &result) != nil || !fileID.MatchString(result.Instance) {
			fail(503, "HERDR_OUTCOME_UNKNOWN")
			return
		}
		if request.Instance != "" && result.Instance != request.Instance && result.Code != "HERDR_STALE" {
			fail(503, "HERDR_OUTCOME_UNKNOWN")
			return
		}
		reply(200, result)
	})
}
