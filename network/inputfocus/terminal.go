package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type terminalRequest struct {
	Op        string `json:"op"`
	Instance  string `json:"instance,omitempty"`
	ID        string `json:"id,omitempty"`
	Shell     string `json:"shell,omitempty"`
	Columns   int    `json:"columns,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Sequence  *int64 `json:"sequence,omitempty"`
	Offset    *int64 `json:"offset,omitempty"`
	Data      string `json:"data,omitempty"`
	Action    string `json:"action,omitempty"`
	Epoch     *int64 `json:"epoch,omitempty"`
	Gesture   *int64 `json:"gesture,omitempty"`
	Column    int    `json:"column,omitempty"`
	Row       int    `json:"row,omitempty"`
	Button    int    `json:"button,omitempty"`
	Modifiers int    `json:"modifiers,omitempty"`
}

type terminalMouseState struct {
	Mode             int    `json:"mode"`
	Format           int    `json:"format"`
	Buttons          int    `json:"buttons"`
	RemainingMs      int    `json:"remainingMs"`
	Epoch            int64  `json:"epoch"`
	Offset           int64  `json:"offset"`
	Gesture          int64  `json:"gesture"`
	NextGesture      int64  `json:"nextGesture"`
	AcceptedSequence int64  `json:"acceptedSequence"`
	WrittenSequence  int64  `json:"writtenSequence"`
	Phase            string `json:"phase"`
	Outcome          string `json:"outcome"`
}
type terminalSession struct {
	ID               string              `json:"id"`
	Shell            string              `json:"shell"`
	State            string              `json:"state"`
	Columns          int                 `json:"columns"`
	Rows             int                 `json:"rows"`
	ExitCode         int                 `json:"exitCode"`
	OpenSequence     int64               `json:"openSequence"`
	AcceptedSequence int64               `json:"acceptedSequence"`
	WrittenSequence  int64               `json:"writtenSequence"`
	Start            int64               `json:"start"`
	End              int64               `json:"end"`
	RemainingMs      int64               `json:"remainingMs"`
	Mouse            *terminalMouseState `json:"mouse,omitempty"`
}
type terminalReply struct {
	OK            bool              `json:"ok"`
	Code          string            `json:"code,omitempty"`
	Instance      string            `json:"instance"`
	NextOpen      int64             `json:"nextOpen,omitempty"`
	PasteLimit    int               `json:"pasteLimit,omitempty"`
	Shells        []string          `json:"shells,omitempty"`
	MouseProtocol int               `json:"mouseProtocol,omitempty"`
	Offset        int64             `json:"offset"`
	Next          int64             `json:"next"`
	Gap           bool              `json:"gap"`
	Data          string            `json:"data,omitempty"`
	Session       *terminalSession  `json:"session,omitempty"`
	Sessions      []terminalSession `json:"sessions,omitempty"`
}
type terminalControl struct {
	clients     string
	read        func(string) (json.RawMessage, error)
	cleanupRead func(string) (json.RawMessage, error)
	mu          sync.Mutex
	started     bool
}

func (r *terminalReply) UnmarshalJSON(data []byte) error {
	type wire terminalReply
	var value wire
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for key, raw := range fields {
		if strings.EqualFold(key, "shells") && (key != "shells" || string(raw) == "null") {
			return errors.New("invalid terminal shell inventory")
		}
	}
	*r = terminalReply(value)
	return nil
}

// This list is sent only through the trusted local worker pipe. The network
// client cannot supply an owner or refresh a revoked session's authorization.
func terminalOwners(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 4*1024*1024 {
		return nil, errors.New("pairing unavailable")
	}
	var database struct {
		Root struct {
			Devices []struct {
				Cert    string          `json:"cert"`
				Enabled json.RawMessage `json:"enabled"`
			} `json:"named_devices"`
		} `json:"root"`
	}
	if json.Unmarshal(raw, &database) != nil {
		return nil, errors.New("pairing unavailable")
	}
	counts := make(map[string]int)
	enabled := make(map[string]bool)
	for _, device := range database.Root.Devices {
		block, _ := pem.Decode([]byte(device.Cert))
		if block == nil || block.Type != "CERTIFICATE" || len(block.Bytes) == 0 {
			continue
		}
		digest := sha256.Sum256(block.Bytes)
		owner := hex.EncodeToString(digest[:])
		counts[owner]++
		enabled[owner] = pairingEnabled(device.Enabled)
	}
	result := make([]string, 0)
	for owner, count := range counts {
		if count == 1 && enabled[owner] {
			result = append(result, owner)
		}
	}
	if len(result) > 256 {
		return nil, errors.New("too many paired identities")
	}
	sort.Strings(result)
	return result, nil
}
func (p *terminalControl) syncLocked(shutdown bool) error {
	owners, err := terminalOwners(p.clients)
	if shutdown || err != nil {
		owners = []string{}
	}
	payload, _ := json.Marshal(struct {
		Op     string   `json:"op"`
		Owners []string `json:"owners"`
	}{"sync", owners})
	p.started = true
	read := p.read
	if shutdown && p.cleanupRead != nil {
		read = p.cleanupRead
	}
	raw, readErr := read(string(payload))
	var reply terminalReply
	if readErr != nil || len(raw) > 65536 || json.Unmarshal(raw, &reply) != nil || !reply.OK || !fileID.MatchString(reply.Instance) {
		p.started = false
		return errors.New("terminal authorization unavailable")
	}
	return err
}
func (p *terminalControl) maintain(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			p.mu.Lock()
			if p.started {
				_ = p.syncLocked(true)
			}
			p.mu.Unlock()
			return
		case <-ticker.C:
			p.mu.Lock()
			if p.started {
				_ = p.syncLocked(false)
			}
			p.mu.Unlock()
		}
	}
}
func validTerminalShell(shell string) bool {
	return shell == "cmd" || shell == "powershell" || shell == "zsh" || shell == "bash"
}
func validTerminalRequest(r terminalRequest) bool {
	if r.Op != "mouse" && (r.Action != "" || r.Epoch != nil || r.Gesture != nil || r.Column != 0 || r.Row != 0 || r.Button != 0 || r.Modifiers != 0) {
		return false
	}
	if r.Op == "list" {
		return r.Instance == "" && r.ID == "" && r.Shell == "" && r.Columns == 0 && r.Rows == 0 && r.Sequence == nil && r.Offset == nil && r.Data == ""
	}
	if !fileID.MatchString(r.Instance) || !fileID.MatchString(r.ID) {
		return false
	}
	dimensions := r.Columns >= 20 && r.Columns <= 240 && r.Rows >= 5 && r.Rows <= 120
	sequence := r.Sequence != nil && *r.Sequence > 0 && *r.Sequence < 1<<53
	switch r.Op {
	case "mouse":
		if r.Shell != "" || r.Columns != 0 || r.Rows != 0 || !sequence || r.Offset != nil || r.Data != "" || r.Epoch == nil || *r.Epoch < 1 || *r.Epoch >= 1<<53 || r.Gesture == nil || *r.Gesture < 0 || *r.Gesture >= 1<<53 {
			return false
		}
		if r.Action == "renew" || r.Action == "cancel" {
			return *r.Gesture > 0 && r.Column == 0 && r.Row == 0 && r.Button == 0 && r.Modifiers == 0
		}
		if r.Column < 1 || r.Column > 65535 || r.Row < 1 || r.Row > 65535 || r.Modifiers < 0 || r.Modifiers > 28 || r.Modifiers%4 != 0 {
			return false
		}
		switch r.Action {
		case "press":
			return r.Button >= 0 && r.Button <= 2
		case "release":
			return *r.Gesture > 0 && r.Button >= 0 && r.Button <= 2
		case "move":
			return r.Button >= 0 && r.Button <= 3 && ((*r.Gesture == 0) == (r.Button == 3))
		case "wheel":
			return *r.Gesture == 0 && r.Button >= 0 && r.Button <= 3
		}
		return false
	case "open":
		return validTerminalShell(r.Shell) && dimensions && sequence && r.Offset == nil && r.Data == ""
	case "read":
		return r.Shell == "" && r.Columns == 0 && r.Rows == 0 && r.Sequence == nil && r.Offset != nil && *r.Offset >= 0 && *r.Offset < 1<<53 && r.Data == ""
	case "write", "paste":
		limit := 4096
		if r.Op == "paste" {
			limit = 16396
		}
		bytes, err := base64.StdEncoding.DecodeString(r.Data)
		return r.Shell == "" && r.Columns == 0 && r.Rows == 0 && sequence && r.Offset == nil && err == nil && len(bytes) > 0 && len(bytes) <= limit && base64.StdEncoding.EncodeToString(bytes) == r.Data
	case "resize":
		return r.Shell == "" && dimensions && r.Sequence == nil && r.Offset == nil && r.Data == ""
	case "close":
		return r.Shell == "" && r.Columns == 0 && r.Rows == 0 && r.Sequence == nil && r.Offset == nil && r.Data == ""
	}
	return false
}
func validTerminalSession(s terminalSession) bool {
	state := s.State == "running" || s.State == "closed" || s.State == "exited" || s.State == "expired" || s.State == "revoked" || s.State == "failed"
	return validTerminalMouse(s.Mouse, s.End) && fileID.MatchString(s.ID) && validTerminalShell(s.Shell) && state && s.Columns >= 20 && s.Columns <= 240 && s.Rows >= 5 && s.Rows <= 120 &&
		s.OpenSequence > 0 && s.OpenSequence < 1<<53 && s.AcceptedSequence >= 0 && s.AcceptedSequence < 1<<53 && s.WrittenSequence >= 0 && s.WrittenSequence <= s.AcceptedSequence &&
		s.Start >= 0 && s.End >= s.Start && s.End < 1<<53 && s.End-s.Start <= 1024*1024 && s.RemainingMs >= 0 && s.RemainingMs <= 1800000
}
func validTerminalMouse(m *terminalMouseState, end int64) bool {
	if m == nil {
		return true
	}
	mode := m.Mode == -1 || m.Mode == 0 || m.Mode == 9 || m.Mode >= 1000 && m.Mode <= 1003
	format := m.Format == -1 || m.Format == 0 || m.Format == 1005 || m.Format == 1006 || m.Format == 1015 || m.Format == 1016
	phase := m.Phase == "idle" || m.Phase == "pending" || m.Phase == "held" || m.Phase == "expired" || m.Phase == "cancelled" || m.Phase == "mode-changed" || m.Phase == "closed"
	outcome := m.Outcome == "none" || m.Outcome == "queued" || m.Outcome == "written" || m.Outcome == "renewed" || m.Outcome == "cancelled" || m.Outcome == "expired" || m.Outcome == "mode-changed"
	return mode && format && phase && outcome && m.Buttons >= 0 && m.Buttons <= 7 && m.RemainingMs >= 0 && m.RemainingMs <= 1500 && m.Epoch > 0 && m.Epoch < 1<<53 && m.Offset >= 0 && m.Offset <= end && m.Gesture >= 0 && m.NextGesture > m.Gesture && m.NextGesture < 1<<53 && m.AcceptedSequence >= 0 && m.AcceptedSequence < 1<<53 && m.WrittenSequence >= 0 && m.WrittenSequence <= m.AcceptedSequence && (m.Phase != "closed" || m.Buttons == 0 && m.RemainingMs == 0)
}
func validTerminalReply(request terminalRequest, value terminalReply) bool {
	if !value.OK || !fileID.MatchString(value.Instance) {
		return false
	}
	if request.Op == "list" {
		shells := map[string]bool{"cmd": true, "powershell": true}
		if value.Shells != nil {
			if len(value.Shells) < 1 || len(value.Shells) > 4 {
				return false
			}
			shells = make(map[string]bool)
			for _, shell := range value.Shells {
				if !validTerminalShell(shell) || shells[shell] {
					return false
				}
				shells[shell] = true
			}
		}
		if value.NextOpen <= 0 || value.NextOpen >= 1<<53 || value.Session != nil || len(value.Sessions) > 32 || value.Data != "" || (value.PasteLimit != 0 && value.PasteLimit != 16396) || (value.MouseProtocol != 0 && value.MouseProtocol != 1) {
			return false
		}
		seen := make(map[string]bool)
		for _, s := range value.Sessions {
			if !validTerminalSession(s) || !shells[s.Shell] || value.MouseProtocol == 1 && s.Mouse == nil || seen[s.ID] || s.OpenSequence >= value.NextOpen {
				return false
			}
			seen[s.ID] = true
		}
		return true
	}
	if request.Instance != value.Instance || value.Session == nil || !validTerminalSession(*value.Session) || value.Session.ID != request.ID || len(value.Sessions) != 0 || value.Shells != nil {
		return false
	}
	if request.Op == "read" {
		data, err := base64.StdEncoding.DecodeString(value.Data)
		return err == nil && len(data) <= 32768 && base64.StdEncoding.EncodeToString(data) == value.Data && value.Offset >= *request.Offset &&
			value.Gap == (value.Offset != *request.Offset) && value.Next == value.Offset+int64(len(data)) && value.Next <= value.Session.End
	}
	if value.Data != "" {
		return false
	}
	if request.Op == "open" {
		return value.Session.OpenSequence == *request.Sequence && value.Session.Shell == request.Shell
	}
	if request.Op == "write" || request.Op == "paste" {
		return value.Session.AcceptedSequence == *request.Sequence
	}
	if request.Op == "mouse" {
		return value.Session.Mouse != nil && value.Session.Mouse.AcceptedSequence == *request.Sequence
	}
	return true
}
func (p *terminalControl) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/terminal" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value terminalReply) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, terminalReply{Code: code}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(p.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "TERMINAL_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "TERMINAL_BAD_REQUEST")
			return
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768))
		decoder.DisallowUnknownFields()
		var request terminalRequest
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !validTerminalRequest(request) {
			fail(400, "TERMINAL_BAD_REQUEST")
			return
		}
		if !p.mu.TryLock() {
			fail(429, "TERMINAL_BUSY")
			return
		}
		defer p.mu.Unlock()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		if !allowed() {
			fail(403, "TERMINAL_UNPAIRED")
			return
		}
		if p.syncLocked(false) != nil {
			fail(503, "TERMINAL_UNAVAILABLE")
			return
		}
		if !allowed() {
			_ = p.syncLocked(false)
			fail(403, "TERMINAL_UNPAIRED")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		payload, _ := json.Marshal(struct {
			terminalRequest
			Owner string `json:"owner"`
		}{request, hex.EncodeToString(digest[:])})
		raw, err := p.read(string(payload))
		var result terminalReply
		if !allowed() {
			_ = p.syncLocked(false)
			fail(403, "TERMINAL_UNPAIRED")
			return
		}
		if err != nil || len(raw) > 65536 || json.Unmarshal(raw, &result) != nil {
			fail(503, "TERMINAL_UNAVAILABLE")
			return
		}
		if !result.OK {
			switch result.Code {
			case "TERMINAL_BUSY", "TERMINAL_CAPACITY":
				fail(429, result.Code)
			case "TERMINAL_UNPAIRED":
				fail(403, result.Code)
			case "TERMINAL_STALE", "TERMINAL_NOT_FOUND", "TERMINAL_CLOSED", "TERMINAL_OFFSET", "TERMINAL_SEQUENCE", "TERMINAL_ID_CONFLICT", "TERMINAL_INPUT_CONFLICT", "TERMINAL_MOUSE_MODE", "TERMINAL_MOUSE_GESTURE", "TERMINAL_MOUSE_SEQUENCE", "TERMINAL_MOUSE_CONFLICT":
				fail(409, result.Code)
			case "TERMINAL_USER_REQUIRED", "TERMINAL_UNSUPPORTED":
				fail(503, result.Code)
			default:
				fail(503, "TERMINAL_UNAVAILABLE")
			}
			return
		}
		if !validTerminalReply(request, result) {
			fail(503, "TERMINAL_INVALID_RESPONSE")
			return
		}
		reply(200, result)
	})
}
