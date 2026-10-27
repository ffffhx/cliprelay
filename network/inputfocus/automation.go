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

// Automation shares the paired control listener. No caller-supplied owner,
// executable, command line or transport address reaches the desktop worker.
type automationRequest struct {
	Op        string          `json:"op"`
	Instance  string          `json:"instance,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Session   string          `json:"session,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
}
type automationReply struct {
	OK       bool            `json:"ok"`
	Code     string          `json:"code,omitempty"`
	Instance string          `json:"instance"`
	Result   json.RawMessage `json:"result,omitempty"`
}
type automationControl struct {
	clients           string
	read, cleanupRead func(string) (json.RawMessage, error)
	mu                sync.Mutex
	started           bool
}

func (a *automationControl) syncLocked(stop bool) error {
	owners, err := terminalOwners(a.clients)
	if stop || err != nil {
		owners = []string{}
	}
	payload, _ := json.Marshal(struct {
		Op     string   `json:"op"`
		Owners []string `json:"owners"`
	}{"sync", owners})
	read := a.read
	if stop && a.cleanupRead != nil {
		read = a.cleanupRead
	}
	a.started = true
	raw, readErr := read(string(payload))
	var value automationReply
	if readErr != nil || json.Unmarshal(raw, &value) != nil || !value.OK || !fileID.MatchString(value.Instance) {
		return errors.New("automation authorization unavailable")
	}
	return err
}
func (a *automationControl) maintain(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			a.mu.Lock()
			if a.started {
				_ = a.syncLocked(true)
			}
			a.mu.Unlock()
			return
		case <-tick.C:
			a.mu.Lock()
			if a.started {
				_ = a.syncLocked(false)
			}
			a.mu.Unlock()
		}
	}
}
func validAutomationRequest(r automationRequest) bool {
	if len(r.Params) > 49152 || (len(r.Params) > 0 && r.Params[0] != '{') {
		return false
	}
	if r.Op == "capabilities" {
		return r.Instance == "" && r.RequestID == "" && r.Session == "" && len(r.Params) == 0
	}
	if !fileID.MatchString(r.Instance) || !fileID.MatchString(r.RequestID) || (r.Session != "" && !fileID.MatchString(r.Session)) {
		return false
	}
	switch r.Op {
	case "status", "profiles", "profile", "apps", "browser.open", "browser.observe", "browser.action", "browser.tabs", "browser.navigate", "browser.tab_close", "browser.handoff", "browser.resume", "browser.close", "windows", "window.observe", "window.action", "window.screenshot", "close":
		return true
	}
	return false
}
func (a *automationControl) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/automation" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value automationReply) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, automationReply{Code: code}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(a.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "AUTOMATION_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "AUTOMATION_BAD_REQUEST")
			return
		}
		var request automationRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !validAutomationRequest(request) {
			fail(400, "AUTOMATION_BAD_REQUEST")
			return
		}
		if !a.mu.TryLock() {
			fail(429, "AUTOMATION_BUSY")
			return
		}
		defer a.mu.Unlock()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(50 * time.Second))
		if !allowed() {
			fail(403, "AUTOMATION_UNPAIRED")
			return
		}
		if a.syncLocked(false) != nil {
			fail(503, "AUTOMATION_UNAVAILABLE")
			return
		}
		if !allowed() {
			_ = a.syncLocked(false)
			fail(403, "AUTOMATION_UNPAIRED")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		payload, _ := json.Marshal(struct {
			automationRequest
			Owner string `json:"owner"`
		}{request, hex.EncodeToString(digest[:])})
		raw, err := a.read(string(payload))
		var result automationReply
		if !allowed() {
			_ = a.syncLocked(false)
			fail(403, "AUTOMATION_UNPAIRED")
			return
		}
		if err != nil || len(raw) > 4*1024*1024 || json.Unmarshal(raw, &result) != nil || !fileID.MatchString(result.Instance) {
			fail(503, "AUTOMATION_OUTCOME_UNKNOWN")
			return
		}
		if request.Instance != "" && result.Instance != request.Instance && result.Code != "AUTOMATION_STALE" {
			fail(503, "AUTOMATION_OUTCOME_UNKNOWN")
			return
		}
		reply(200, result)
	})
}
