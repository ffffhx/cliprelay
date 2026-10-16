package inputfocus

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"image/jpeg"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const relayChunk = 8192
const relayReadChunk = 256 * 1024
const relayLimit = 25 * 1024 * 1024
const relayMemory = 64 * 1024 * 1024
const relayLineLimit = 16384
const relayPresence = 25 * time.Second

type relayCommand struct {
	Op     string `json:"op"`
	Owner  string `json:"owner,omitempty"`
	ID     string `json:"id,omitempty"`
	Kind   string `json:"kind,omitempty"`
	Size   int    `json:"size,omitempty"`
	Offset int    `json:"offset,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Data   string `json:"data,omitempty"`
}
type relayPeer struct {
	Owner  string `json:"owner"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}
type relayReply struct {
	OK     bool        `json:"ok"`
	Code   string      `json:"code,omitempty"`
	ID     string      `json:"id,omitempty"`
	State  string      `json:"state,omitempty"`
	Kind   string      `json:"kind,omitempty"`
	Size   int         `json:"size,omitempty"`
	Offset int         `json:"offset,omitempty"`
	SHA256 string      `json:"sha256,omitempty"`
	Data   string      `json:"data,omitempty"`
	Peers  []relayPeer `json:"peers,omitempty"`
}
type relayItem struct {
	owner, id, kind, hash, state string
	size                         int
	body                         []byte
	created, expires             time.Time
	order                        uint64
}
type relayMailbox struct {
	mu        sync.Mutex
	clients   string
	now       func() time.Time
	items     map[string]*relayItem
	seen      map[string]time.Time
	allocated int
	changed   chan struct{}
	sequence  uint64
	readers   map[string]int
}

func newRelayMailbox(clients string) *relayMailbox {
	return &relayMailbox{clients: clients, now: time.Now, items: map[string]*relayItem{}, seen: map[string]time.Time{}, changed: make(chan struct{}), readers: map[string]int{}}
}
func relayError(code string) relayReply { return relayReply{Code: code} }
func (m *relayMailbox) notify()         { close(m.changed); m.changed = make(chan struct{}) }
func (m *relayMailbox) release(item *relayItem, state string) {
	if item.body != nil {
		m.allocated -= item.size
		item.body = nil
	}
	item.state = state
	item.expires = m.now().Add(2 * time.Minute)
	m.notify()
}
func (m *relayMailbox) prune(owners map[string]string) {
	now := m.now()
	for key, item := range m.items {
		if _, allowed := owners[item.owner]; !allowed {
			if item.body != nil {
				m.release(item, "revoked")
			}
			delete(m.items, key)
			continue
		}
		if !now.Before(item.expires) {
			if item.body != nil {
				m.release(item, "expired")
			} else {
				delete(m.items, key)
			}
		}
	}
	for owner, when := range m.seen {
		if now.Sub(when) > time.Minute {
			delete(m.seen, owner)
		}
	}
}

func (m *relayMailbox) maintain(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.mu.Lock()
			for _, item := range m.items {
				m.release(item, "cancelled")
			}
			m.mu.Unlock()
			return
		case <-ticker.C:
			m.mu.Lock()
			m.prune(relayOwners(m.clients))
			m.mu.Unlock()
		}
	}
}
func relayOwners(path string) map[string]string {
	result := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return result
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 4*1024*1024+1))
	if err != nil || len(raw) > 4*1024*1024 {
		return result
	}
	var db struct {
		Root struct {
			Devices []struct {
				Name    string          `json:"name"`
				Cert    string          `json:"cert"`
				Enabled json.RawMessage `json:"enabled"`
			} `json:"named_devices"`
		} `json:"root"`
	}
	if json.Unmarshal(raw, &db) != nil || len(db.Root.Devices) > 256 {
		return result
	}
	seen := map[string]bool{}
	for _, entry := range db.Root.Devices {
		block, _ := pem.Decode([]byte(entry.Cert))
		if block == nil || block.Type != "CERTIFICATE" || len(block.Bytes) == 0 {
			continue
		}
		hash := sha256.Sum256(block.Bytes)
		owner := hex.EncodeToString(hash[:])
		duplicate := seen[owner]
		seen[owner] = true
		if duplicate || !pairingEnabled(entry.Enabled) {
			delete(result, owner)
			continue
		}
		name := entry.Name
		if !utf8.ValidString(name) || len(name) > 256 || strings.TrimSpace(name) == "" {
			name = "Paired device"
		}
		result[owner] = name
	}
	return result
}
func (m *relayMailbox) local(c relayCommand) relayReply {
	m.mu.Lock()
	defer m.mu.Unlock()
	owners := relayOwners(m.clients)
	m.prune(owners)
	if c.Op == "peers" {
		peers := []relayPeer{}
		for owner, name := range owners {
			peers = append(peers, relayPeer{owner, name, m.now().Sub(m.seen[owner]) < relayPresence})
		}
		sort.Slice(peers, func(i, j int) bool { return peers[i].Owner < peers[j].Owner })
		return relayReply{OK: true, Peers: peers}
	}
	if _, allowed := owners[c.Owner]; !allowed {
		return relayError("RELAY_UNPAIRED")
	}
	if !fileID.MatchString(c.ID) {
		return relayError("RELAY_BAD_REQUEST")
	}
	key := c.Owner + ":" + c.ID
	item := m.items[key]
	switch c.Op {
	case "begin":
		if (c.Kind != "json" && c.Kind != "jpeg") || c.Size < 1 || c.Size > relayLimit || (c.Kind == "json" && c.Size > clipboardTextLimit) || !fileHash.MatchString(c.SHA256) {
			return relayError("RELAY_BAD_REQUEST")
		}
		if item != nil {
			if item.kind != c.Kind || item.size != c.Size || item.hash != c.SHA256 {
				return relayError("RELAY_ID_CONFLICT")
			}
			return relayReply{OK: true, ID: item.id, State: item.state, Offset: len(item.body)}
		}
		if m.now().Sub(m.seen[c.Owner]) >= relayPresence {
			return relayError("RELAY_OFFLINE")
		}
		if m.allocated+c.Size > relayMemory || len(m.items) >= 256 {
			return relayError("RELAY_BUSY")
		}
		pending := 0
		for _, existing := range m.items {
			if existing.owner == c.Owner && existing.body != nil {
				pending++
			}
		}
		if pending >= 16 {
			return relayError("RELAY_BUSY")
		}
		item = &relayItem{owner: c.Owner, id: c.ID, kind: c.Kind, hash: c.SHA256, state: "uploading", size: c.Size, body: make([]byte, 0, c.Size), created: m.now(), expires: m.now().Add(30 * time.Second)}
		m.sequence++
		item.order = m.sequence
		m.items[key] = item
		m.allocated += c.Size
	case "chunk":
		if item == nil || item.state != "uploading" {
			return relayError("RELAY_NOT_READY")
		}
		if len(c.Data) > base64.StdEncoding.EncodedLen(relayChunk) {
			return relayError("RELAY_BAD_REQUEST")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(c.Data)
		if err != nil || len(data) < 1 || len(data) > relayChunk || c.Offset < 0 || c.Offset > len(item.body) || c.Offset+len(data) > item.size {
			return relayError("RELAY_BAD_REQUEST")
		}
		if c.Offset < len(item.body) {
			if c.Offset+len(data) > len(item.body) || !bytes.Equal(item.body[c.Offset:c.Offset+len(data)], data) {
				return relayError("RELAY_CHUNK_CONFLICT")
			}
		} else {
			item.body = append(item.body, data...)
		}
		item.expires = minTime(m.now().Add(30*time.Second), item.created.Add(5*time.Minute))
	case "commit":
		if item == nil {
			return relayError("RELAY_NOT_READY")
		}
		if item.state == "uploading" {
			hash := sha256.Sum256(item.body)
			if len(item.body) != item.size || hex.EncodeToString(hash[:]) != item.hash {
				return relayError("RELAY_HASH_MISMATCH")
			}
			if !validRelayBody(item.kind, item.body) {
				m.release(item, "rejected")
				return relayError("RELAY_BAD_REQUEST")
			}
			item.state = "queued"
			item.expires = minTime(m.now().Add(2*time.Minute), item.created.Add(5*time.Minute))
			m.notify()
		}
	case "status":
		if item == nil {
			return relayError("RELAY_NOT_FOUND")
		}
	case "cancel":
		if item == nil {
			return relayError("RELAY_NOT_FOUND")
		}
		if item.state != "delivered" {
			m.release(item, "cancelled")
		}
	default:
		return relayError("RELAY_BAD_REQUEST")
	}
	return relayReply{OK: true, ID: item.id, State: item.state, Offset: len(item.body)}
}
func validRelayBody(kind string, body []byte) bool {
	if kind == "json" {
		var value struct {
			Text  string `json:"text"`
			Probe bool   `json:"probe,omitempty"`
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		return len(body) <= clipboardTextLimit && utf8.Valid(body) && decoder.Decode(&value) == nil && decoder.Decode(new(any)) == io.EOF && value.Text != "" && !strings.ContainsRune(value.Text, 0)
	}
	if kind == "jpeg" {
		image, err := jpeg.DecodeConfig(bytes.NewReader(body))
		return err == nil && len(body) <= relayLimit && image.Width > 0 && image.Height > 0 && image.Width <= 32768 && image.Height <= 32768 && int64(image.Width)*int64(image.Height) <= 100000000
	}
	return false
}
func (m *relayMailbox) remote(owner string, c relayCommand) relayReply {
	m.mu.Lock()
	defer m.mu.Unlock()
	owners := relayOwners(m.clients)
	m.prune(owners)
	if _, allowed := owners[owner]; !allowed {
		return relayError("RELAY_UNPAIRED")
	}
	if !validRelayRemote(c) {
		return relayError("RELAY_BAD_REQUEST")
	}
	m.seen[owner] = m.now()
	if c.Op == "poll" {
		var next *relayItem
		for _, item := range m.items {
			if item.owner == owner && item.state == "queued" && (next == nil || item.order < next.order) {
				next = item
			}
		}
		if next == nil {
			return relayReply{OK: true, State: "idle"}
		}
		return relayReply{OK: true, ID: next.id, State: "queued", Kind: next.kind, Size: next.size, SHA256: next.hash}
	}
	if !fileID.MatchString(c.ID) {
		return relayError("RELAY_BAD_REQUEST")
	}
	item := m.items[owner+":"+c.ID]
	if item == nil {
		return relayError("RELAY_NOT_FOUND")
	}
	switch c.Op {
	case "read":
		if item.state != "queued" || c.Offset < 0 || c.Offset >= len(item.body) {
			return relayError("RELAY_NOT_READY")
		}
		end := min(c.Offset+relayReadChunk, len(item.body))
		item.expires = minTime(m.now().Add(2*time.Minute), item.created.Add(5*time.Minute))
		return relayReply{OK: true, ID: item.id, Offset: c.Offset, Data: base64.StdEncoding.EncodeToString(item.body[c.Offset:end])}
	case "ack":
		if (item.state != "queued" && item.state != "delivered") || c.SHA256 != item.hash {
			return relayError("RELAY_BAD_REQUEST")
		}
		if item.state != "delivered" {
			m.release(item, "delivered")
		}
		return relayReply{OK: true, ID: item.id, State: item.state}
	case "reject":
		if item.state == "queued" {
			m.release(item, "rejected")
		}
		return relayReply{OK: true, ID: item.id, State: item.state}
	}
	return relayError("RELAY_BAD_REQUEST")
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func validRelayRemote(c relayCommand) bool {
	if c.Owner != "" || c.Kind != "" || c.Size != 0 || c.Data != "" {
		return false
	}
	switch c.Op {
	case "poll":
		return c.ID == "" && c.Offset == 0 && c.SHA256 == ""
	case "read":
		return fileID.MatchString(c.ID) && c.Offset >= 0 && c.SHA256 == ""
	case "ack":
		return fileID.MatchString(c.ID) && c.Offset == 0 && fileHash.MatchString(c.SHA256)
	case "reject":
		return fileID.MatchString(c.ID) && c.Offset == 0 && c.SHA256 == ""
	}
	return false
}
func (m *relayMailbox) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/relay" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		reply := func(status int, value relayReply) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(value) }
		authorized := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(m.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !authorized() {
			reply(403, relayError("RELAY_UNPAIRED"))
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/json" {
			reply(400, relayError("RELAY_BAD_REQUEST"))
			return
		}
		var request struct {
			Op     string `json:"op"`
			ID     string `json:"id,omitempty"`
			Offset int    `json:"offset,omitempty"`
			SHA256 string `json:"sha256,omitempty"`
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, relayLineLimit))
		if err != nil || !utf8.Valid(raw) {
			reply(400, relayError("RELAY_BAD_REQUEST"))
			return
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			reply(400, relayError("RELAY_BAD_REQUEST"))
			return
		}
		hash := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(hash[:])
		command := relayCommand{Op: request.Op, ID: request.ID, Offset: request.Offset, SHA256: request.SHA256}
		if !validRelayRemote(command) {
			reply(400, relayError("RELAY_BAD_REQUEST"))
			return
		}
		m.mu.Lock()
		if m.readers[owner] >= 2 || len(m.readers) >= 64 && m.readers[owner] == 0 {
			m.mu.Unlock()
			reply(429, relayError("RELAY_BUSY"))
			return
		}
		m.readers[owner]++
		m.mu.Unlock()
		defer func() {
			m.mu.Lock()
			m.readers[owner]--
			if m.readers[owner] == 0 {
				delete(m.readers, owner)
			}
			m.mu.Unlock()
		}()
		// Chunk delivery over slower relays gets a bounded deadline of its own.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		if request.Op == "poll" {
			// Bound long polling; recheck both cancellation and revocation before reply.
			m.mu.Lock()
			wake := m.changed
			m.mu.Unlock()
			first := m.remote(owner, command)
			if first.OK && first.State == "idle" {
				select {
				case <-wake:
				case <-r.Context().Done():
					return
				case <-time.After(10 * time.Second):
				}
			}
		}
		result := m.remote(owner, command)
		if !authorized() {
			reply(403, relayError("RELAY_UNPAIRED"))
			return
		}
		status := 200
		if !result.OK {
			status = 409
		}
		reply(status, result)
	})
}

// Local publisher IPC is implemented by an OS-protected listener, not HTTP.
func (m *relayMailbox) serveLocal(ctx context.Context, listener net.Listener, local ...func([]byte) (any, bool)) error {
	ctx, cancel := context.WithCancel(ctx)
	var pending sync.WaitGroup
	var mu sync.Mutex
	connections := make(map[net.Conn]struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		_ = listener.Close()
		mu.Lock()
		for connection := range connections {
			_ = connection.Close()
		}
		mu.Unlock()
	}()
	defer func() { cancel(); <-stopped; pending.Wait() }()
	workers := make(chan struct{}, 8)
	for {
		connection, err := listener.Accept()
		if err != nil {
			return err
		}
		select {
		case workers <- struct{}{}:
		default:
			connection.Close()
			continue
		}
		mu.Lock()
		if ctx.Err() != nil {
			mu.Unlock()
			<-workers
			_ = connection.Close()
			return ctx.Err()
		}
		connections[connection] = struct{}{}
		pending.Add(1)
		mu.Unlock()
		go func() {
			defer pending.Done()
			defer func() { <-workers }()
			defer func() {
				_ = connection.Close()
				mu.Lock()
				delete(connections, connection)
				mu.Unlock()
			}()
			_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
			line, err := bufio.NewReaderSize(connection, relayLineLimit+1).ReadSlice('\n')
			if err != nil || len(line) > relayLineLimit || !utf8.Valid(line) {
				return
			}
			if len(local) > 0 && local[0] != nil {
				if reply, handled := local[0](line); handled {
					_ = json.NewEncoder(connection).Encode(reply)
					return
				}
			}
			decoder := json.NewDecoder(bytes.NewReader(line))
			decoder.DisallowUnknownFields()
			var command relayCommand
			if decoder.Decode(&command) != nil || decoder.Decode(new(any)) != io.EOF {
				return
			}
			_ = json.NewEncoder(connection).Encode(m.local(command))
		}()
	}
}
