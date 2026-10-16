// Package hostterminal implements the application-owned Unix terminal service.
// Only the authenticated control service can supply the live certificate list.
package hostterminal

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
)

const (
	RequestLimit          = 32768
	ReplyLimit            = 65536
	OutputLimit           = 1024 * 1024
	ReadLimit             = 32768
	PasteLimit            = 16396
	IdleMs          int64 = 1800000
	AuthorizationMs int64 = 20000
	RetentionMs     int64 = 300000
	MaxSequence     int64 = 1<<53 - 1
)

type Request struct {
	Op       string   `json:"op"`
	Owner    string   `json:"owner,omitempty"`
	Owners   []string `json:"owners,omitempty"`
	Instance string   `json:"instance,omitempty"`
	ID       string   `json:"id,omitempty"`
	Shell    string   `json:"shell,omitempty"`
	Columns  int      `json:"columns,omitempty"`
	Rows     int      `json:"rows,omitempty"`
	Sequence int64    `json:"sequence,omitempty"`
	Offset   int64    `json:"offset,omitempty"`
	Data     string   `json:"data,omitempty"`
}
type SessionState struct {
	ID               string `json:"id"`
	Shell            string `json:"shell"`
	State            string `json:"state"`
	Columns          int    `json:"columns"`
	Rows             int    `json:"rows"`
	ExitCode         int    `json:"exitCode"`
	OpenSequence     int64  `json:"openSequence"`
	AcceptedSequence int64  `json:"acceptedSequence"`
	WrittenSequence  int64  `json:"writtenSequence"`
	Start            int64  `json:"start"`
	End              int64  `json:"end"`
	RemainingMs      int64  `json:"remainingMs"`
}
type Reply struct {
	OK         bool           `json:"ok"`
	Code       string         `json:"code,omitempty"`
	Instance   string         `json:"instance"`
	NextOpen   int64          `json:"nextOpen,omitempty"`
	Shells     []string       `json:"shells,omitempty"`
	PasteLimit int            `json:"pasteLimit,omitempty"`
	Session    *SessionState  `json:"session,omitempty"`
	Sessions   []SessionState `json:"sessions,omitempty"`
	Offset     int64          `json:"offset"`
	Next       int64          `json:"next"`
	Gap        bool           `json:"gap"`
	Data       string         `json:"data,omitempty"`
}
type ProcessState struct {
	Written        int64
	Exited, Failed bool
	ExitCode       int
}

// Queue and Close must not block on terminal I/O. Close starts cancellation;
// Done closes after its I/O and operating-system child have been joined.
type Process interface {
	Queue([]byte, int64, bool) bool
	Resize(int, int) error
	Status() ProcessState
	Close()
	Done() <-chan struct{}
}
type Factory func(string, int, int, func([]byte)) (Process, error)

type Buffer struct {
	mu   sync.Mutex
	data []byte
	end  int64
}

func NewBuffer() *Buffer { return &Buffer{data: make([]byte, OutputLimit)} }
func (b *Buffer) Append(data []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, value := range data {
		b.data[b.end%int64(len(b.data))] = value
		b.end++
	}
}
func (b *Buffer) bounds() (int64, int64) { return max(0, b.end-int64(len(b.data))), b.end }
func (b *Buffer) Bounds() (int64, int64) { b.mu.Lock(); defer b.mu.Unlock(); return b.bounds() }
func (b *Buffer) Read(requested int64) ([]byte, int64, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if requested < 0 || requested > b.end {
		return nil, 0, false, errors.New("TERMINAL_OFFSET")
	}
	start, end := b.bounds()
	offset := max(start, requested)
	data := make([]byte, min(ReadLimit, end-offset))
	for index := range data {
		data[index] = b.data[(offset+int64(index))%int64(len(b.data))]
	}
	return data, offset, offset != requested, nil
}

type session struct {
	owner                string
	state                SessionState
	output               *Buffer
	process              Process
	lastAccess, finished int64
	digest               [32]byte
}
type Manager struct {
	mu           sync.Mutex
	now          func() int64
	create       Factory
	instance     string
	owners       map[string]bool
	next         map[string]int64
	sessions     map[string]*session
	processes    []Process
	authorizedAt int64
	closed       bool
}

func New(now func() int64, create Factory) *Manager {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		panic(err)
	}
	return &Manager{now: now, create: create, instance: hex.EncodeToString(random[:]), owners: make(map[string]bool), next: make(map[string]int64), sessions: make(map[string]*session)}
}
func validHex(value string, size int) bool {
	if len(value) != size {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func dimensions(columns, rows int) bool {
	return columns >= 20 && columns <= 240 && rows >= 5 && rows <= 120
}
func shellAllowed(shell string) bool         { return shell == "zsh" || shell == "bash" }
func (m *Manager) failure(code string) Reply { return Reply{Code: code, Instance: m.instance} }
func (m *Manager) snapshot(s *session) SessionState {
	value := s.state
	value.Start, value.End = s.output.Bounds()
	if s.process != nil {
		value.WrittenSequence = s.process.Status().Written
	}
	if value.State == "running" {
		value.RemainingMs = max(0, IdleMs-(m.now()-s.lastAccess))
	}
	return value
}
func (m *Manager) reply(s *session) Reply {
	value := Reply{OK: true, Instance: m.instance}
	if s != nil {
		state := m.snapshot(s)
		value.Session = &state
	}
	return value
}
func (m *Manager) stop(s *session, state string) {
	if s.state.State != "running" {
		return
	}
	s.state.State = state
	s.finished = m.now()
	s.state.ExitCode = -1
	if s.process != nil {
		status := s.process.Status()
		if status.Exited {
			s.state.ExitCode = status.ExitCode
		}
		s.process.Close()
	}
}
func (m *Manager) maintain() {
	if m.now()-m.authorizedAt >= AuthorizationMs {
		clear(m.owners)
	}
	for key, s := range m.sessions {
		if s.state.State == "running" {
			status := s.process.Status()
			switch {
			case !m.owners[s.owner]:
				m.stop(s, "revoked")
			case m.now()-s.lastAccess >= IdleMs:
				m.stop(s, "expired")
			case status.Failed:
				m.stop(s, "failed")
			case status.Exited:
				m.stop(s, "exited")
			}
		} else if m.now()-s.finished >= RetentionMs {
			delete(m.sessions, key)
		}
	}
	active := m.processes[:0]
	for _, process := range m.processes {
		select {
		case <-process.Done():
		default:
			active = append(active, process)
		}
	}
	m.processes = active
}
func (m *Manager) Maintain() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		m.maintain()
	}
}
func (m *Manager) Handle(r Request) Reply {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return m.failure("TERMINAL_UNAVAILABLE")
	}
	if r.Op == "sync" {
		owners := make(map[string]bool)
		if r.Owners == nil || len(r.Owners) > 256 {
			return m.failure("TERMINAL_BAD_REQUEST")
		}
		for _, owner := range r.Owners {
			if !validHex(owner, 64) || owners[owner] {
				return m.failure("TERMINAL_BAD_REQUEST")
			}
			owners[owner] = true
		}
		m.owners = owners
		m.authorizedAt = m.now()
		m.maintain()
		return m.reply(nil)
	}
	m.maintain()
	if !validHex(r.Owner, 64) || !m.owners[r.Owner] {
		return m.failure("TERMINAL_UNPAIRED")
	}
	next := m.next[r.Owner]
	if next == 0 {
		if len(m.next) >= 256 {
			return m.failure("TERMINAL_CAPACITY")
		}
		next = 1
		m.next[r.Owner] = next
	}
	if r.Op == "list" {
		result := m.reply(nil)
		result.NextOpen = next
		result.PasteLimit = PasteLimit
		result.Shells = []string{"zsh", "bash"}
		for _, s := range m.sessions {
			if s.owner == r.Owner {
				result.Sessions = append(result.Sessions, m.snapshot(s))
			}
		}
		sort.Slice(result.Sessions, func(i, j int) bool { return result.Sessions[i].OpenSequence < result.Sessions[j].OpenSequence })
		return result
	}
	if r.Instance != m.instance {
		return m.failure("TERMINAL_STALE")
	}
	if !validHex(r.ID, 32) {
		return m.failure("TERMINAL_BAD_REQUEST")
	}
	key := r.Owner + ":" + r.ID
	s := m.sessions[key]
	if r.Op == "open" {
		if !shellAllowed(r.Shell) || !dimensions(r.Columns, r.Rows) {
			return m.failure("TERMINAL_BAD_REQUEST")
		}
		if s != nil {
			if s.state.OpenSequence != r.Sequence || s.state.Shell != r.Shell {
				return m.failure("TERMINAL_ID_CONFLICT")
			}
			return m.reply(s)
		}
		if r.Sequence != next || next >= MaxSequence {
			return m.failure("TERMINAL_SEQUENCE")
		}
		own := 0
		for _, value := range m.sessions {
			if value.owner == r.Owner && value.process != nil {
				select {
				case <-value.process.Done():
				default:
					own++
				}
			}
		}
		if len(m.processes) >= 8 || own >= 4 {
			return m.failure("TERMINAL_CAPACITY")
		}
		if len(m.sessions) >= 32 {
			var oldest *session
			oldKey := ""
			for k, v := range m.sessions {
				if v.state.State != "running" && (oldest == nil || v.finished < oldest.finished) {
					oldest = v
					oldKey = k
				}
			}
			if oldest == nil {
				return m.failure("TERMINAL_CAPACITY")
			}
			delete(m.sessions, oldKey)
		}
		// Record a failed start too: retrying an uncertain open never creates
		// another shell, including after a receipt has aged out.
		m.next[r.Owner] = next + 1
		s = &session{owner: r.Owner, lastAccess: m.now(), output: NewBuffer(), state: SessionState{ID: r.ID, Shell: r.Shell, State: "running", Columns: r.Columns, Rows: r.Rows, OpenSequence: r.Sequence}}
		m.sessions[key] = s
		process, err := m.create(r.Shell, r.Columns, r.Rows, s.output.Append)
		if err != nil || process == nil {
			if process != nil {
				s.process = process
				m.processes = append(m.processes, process)
			}
			m.stop(s, "failed")
			return m.failure("TERMINAL_UNAVAILABLE")
		}
		s.process = process
		m.processes = append(m.processes, process)
		return m.reply(s)
	}
	if s == nil {
		return m.failure("TERMINAL_NOT_FOUND")
	}
	s.lastAccess = m.now()
	switch r.Op {
	case "close":
		m.stop(s, "closed")
		return m.reply(s)
	case "read":
		data, offset, gap, err := s.output.Read(r.Offset)
		if err != nil {
			return m.failure("TERMINAL_OFFSET")
		}
		result := m.reply(s)
		result.Offset = offset
		result.Next = offset + int64(len(data))
		result.Gap = gap
		result.Data = base64.StdEncoding.EncodeToString(data)
		return result
	}
	if s.state.State != "running" {
		return m.failure("TERMINAL_CLOSED")
	}
	if r.Op == "resize" {
		if !dimensions(r.Columns, r.Rows) {
			return m.failure("TERMINAL_BAD_REQUEST")
		}
		if err := s.process.Resize(r.Columns, r.Rows); err != nil {
			m.stop(s, "failed")
			return m.failure("TERMINAL_UNAVAILABLE")
		}
		s.state.Columns = r.Columns
		s.state.Rows = r.Rows
		return m.reply(s)
	}
	if r.Op != "write" && r.Op != "paste" {
		return m.failure("TERMINAL_BAD_REQUEST")
	}
	limit := 4096
	if r.Op == "paste" {
		limit = PasteLimit
	}
	data, err := base64.StdEncoding.DecodeString(r.Data)
	if err != nil || len(data) == 0 || len(data) > limit || base64.StdEncoding.EncodeToString(data) != r.Data {
		return m.failure("TERMINAL_BAD_REQUEST")
	}
	digest := sha256.Sum256(append([]byte(r.Op+"\x00"), data...))
	if r.Sequence == s.state.AcceptedSequence {
		if r.Sequence == 0 || digest != s.digest {
			return m.failure("TERMINAL_INPUT_CONFLICT")
		}
		return m.reply(s)
	}
	if r.Sequence <= 0 || r.Sequence > MaxSequence || r.Sequence != s.state.AcceptedSequence+1 {
		return m.failure("TERMINAL_SEQUENCE")
	}
	if !s.process.Queue(data, r.Sequence, r.Op == "paste") {
		return m.failure("TERMINAL_BUSY")
	}
	s.state.AcceptedSequence = r.Sequence
	s.digest = digest
	return m.reply(s)
}

// Close withdraws authority and initiates all stops together. The caller must
// join the returned handles before reporting worker shutdown as complete.
func (m *Manager) Close() []Process {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return append([]Process(nil), m.processes...)
	}
	m.closed = true
	for _, s := range m.sessions {
		m.stop(s, "closed")
	}
	clear(m.owners)
	return append([]Process(nil), m.processes...)
}
