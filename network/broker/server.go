package broker

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
)

type Device struct {
	ID         string      `json:"id"`
	TokenHash  string      `json:"tokenHash"`
	Name       string      `json:"name"`
	HostID     string      `json:"hostId"`
	UserID     string      `json:"userId"`
	State      string      `json:"state"`
	Created    time.Time   `json:"created"`
	Expires    time.Time   `json:"expires"`
	NodeID     string      `json:"nodeId,omitempty"`
	Enrollment *Enrollment `json:"enrollment,omitempty"`
}
type PairCode struct {
	Value   string    `json:"value"`
	Expires time.Time `json:"expires"`
}
type database struct {
	Devices map[string]*Device  `json:"devices"`
	Codes   map[string]PairCode `json:"codes"`
}
type rateEntry struct {
	Start time.Time
	Count int
}

type Server struct {
	control    Control
	controlURL string
	statePath  string
	mu         sync.Mutex
	db         database
	rates      map[string]rateEntry
	now        func() time.Time
}

func New(control Control, controlURL, statePath string) (*Server, error) {
	s := &Server{control: control, controlURL: controlURL, statePath: statePath, rates: map[string]rateEntry{}, now: time.Now, db: database{Devices: map[string]*Device{}, Codes: map[string]PairCode{}}}
	b, err := os.ReadFile(statePath)
	if err == nil {
		if err = json.Unmarshal(b, &s.db); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if s.db.Devices == nil || s.db.Codes == nil {
		return nil, errors.New("invalid pairing database")
	}
	return s, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { reply(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /v1/hosts", s.wrap(s.createHost))
	mux.HandleFunc("POST /v1/codes", s.wrap(s.createCode))
	mux.HandleFunc("POST /v1/claims", s.wrap(s.claim))
	mux.HandleFunc("POST /v1/approve", s.wrap(s.approve))
	mux.HandleFunc("POST /v1/revoke", s.wrap(s.revoke))
	mux.HandleFunc("POST /v1/enroll", s.wrap(s.enroll))
	mux.HandleFunc("GET /v1/status", s.wrap(s.status))
	return mux
}

type problem struct {
	Code    int
	Message string
}

func (p problem) Error() string           { return p.Message }
func fail(code int, message string) error { return problem{code, message} }

// Mutations are serialized and persisted before replying. Request bodies and
// authorization headers are never logged. Caddy is the only external listener.
func (s *Server) wrap(f func(http.ResponseWriter, *http.Request, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		decoded, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || len(decoded) != 32 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			reply(w, 401, map[string]string{"error": "device credential required"})
			return
		}
		hash := sha256.Sum256(decoded)
		identity := hex.EncodeToString(hash[:])
		s.mu.Lock()
		defer s.mu.Unlock()
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		// Only our loopback reverse proxy may supply the public client address.
		if net.ParseIP(ip).IsLoopback() {
			if value := r.Header.Get("X-ClipRelay-Client-IP"); net.ParseIP(value) != nil {
				ip = value
			}
		}
		if parsed := net.ParseIP(ip); parsed != nil && parsed.To4() == nil {
			ip = parsed.Mask(net.CIDRMask(64, 128)).String()
		}
		limit := 120
		if r.URL.Path == "/v1/claims" {
			limit = 10
		}
		if r.URL.Path == "/v1/hosts" {
			limit = 5
		}
		if !s.take(ip+r.URL.Path, limit) {
			reply(w, 429, map[string]string{"error": "too many attempts; try again later"})
			return
		}
		if err = f(w, r, identity); err != nil {
			p := problem{503, "pairing service temporarily unavailable"}
			errors.As(err, &p)
			reply(w, p.Code, map[string]string{"error": p.Message})
		}
	}
}
func (s *Server) take(key string, limit int) bool {
	now := s.now()
	e := s.rates[key]
	if now.Sub(e.Start) > time.Minute {
		e = rateEntry{Start: now}
	}
	if e.Count >= limit {
		return false
	}
	e.Count++
	s.rates[key] = e
	if len(s.rates) > 4096 {
		for k, v := range s.rates {
			if now.Sub(v.Start) > time.Minute {
				delete(s.rates, k)
			}
		}
	}
	return len(s.rates) <= 8192
}
func body(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 4097))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return fail(400, "invalid request")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return fail(400, "invalid request")
	}
	return nil
}
func nameOK(name string) bool {
	if len(name) < 1 || len(name) > 128 {
		return false
	}
	for _, c := range name {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func (s *Server) device(identity string) (*Device, error) {
	d := s.db.Devices[identity]
	if d == nil || d.State == "revoked" {
		return nil, fail(401, "device is not paired")
	}
	return d, nil
}
func (s *Server) host(identity string) (*Device, error) {
	d, err := s.device(identity)
	if err != nil {
		return nil, err
	}
	if d.ID != d.HostID {
		return nil, fail(403, "computer confirmation required")
	}
	return d, nil
}
func (s *Server) save() error {
	b, err := json.Marshal(s.db)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.statePath), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.statePath), ".pairing-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), s.statePath)
}
func (s *Server) createHost(w http.ResponseWriter, r *http.Request, identity string) error {
	var req struct {
		Name string `json:"name"`
	}
	if err := body(r, &req); err != nil {
		return err
	}
	if !nameOK(req.Name) {
		return fail(400, "invalid computer name")
	}
	if existing := s.db.Devices[identity]; existing != nil {
		if existing.ID != existing.HostID {
			return fail(409, "credential belongs to a phone")
		}
		reply(w, 200, map[string]string{"id": existing.ID})
		return nil
	}
	if len(s.db.Devices) >= 1000 {
		return fail(503, "device capacity reached")
	}
	id := identity[:24]
	userID, err := s.control.CreateUser(r.Context(), "cr-"+id)
	if err != nil {
		return err
	}
	s.db.Devices[identity] = &Device{ID: id, TokenHash: identity, Name: req.Name, HostID: id, UserID: userID, State: "approved", Created: s.now()}
	if err = s.save(); err != nil {
		delete(s.db.Devices, identity)
		return err
	}
	reply(w, 201, map[string]string{"id": id})
	return nil
}
func (s *Server) createCode(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	if !s.take(identity+":code", 6) {
		return fail(429, "too many pairing codes")
	}
	var code string
	for {
		n, err := rand.Int(rand.Reader, big.NewInt(100000000))
		if err != nil {
			return err
		}
		code = fmt.Sprintf("%08d", n)
		duplicate := false
		for _, v := range s.db.Codes {
			if v.Value == code && v.Expires.After(s.now()) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			break
		}
	}
	pair := PairCode{Value: code, Expires: s.now().Add(5 * time.Minute)}
	previous, existed := s.db.Codes[host.ID]
	s.db.Codes[host.ID] = pair
	if err = s.save(); err != nil {
		if existed {
			s.db.Codes[host.ID] = previous
		} else {
			delete(s.db.Codes, host.ID)
		}
		return err
	}
	reply(w, 200, pair)
	return nil
}
func (s *Server) claim(w http.ResponseWriter, r *http.Request, identity string) error {
	var req struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := body(r, &req); err != nil {
		return err
	}
	if !nameOK(req.Name) || len(req.Code) != 8 {
		return fail(400, "invalid pairing request")
	}
	if existing := s.db.Devices[identity]; existing != nil {
		return fail(409, "device already has a pairing request")
	}
	var hostID string
	for id, c := range s.db.Codes {
		if c.Value == req.Code && c.Expires.After(s.now()) {
			hostID = id
			break
		}
	}
	if hostID == "" {
		return fail(404, "pairing code expired or incorrect")
	}
	var host *Device
	count := 0
	for _, d := range s.db.Devices {
		if d.ID == hostID {
			host = d
		}
		if d.HostID == hostID && d.ID != hostID && d.State != "revoked" && (d.State != "pending" || d.Expires.After(s.now())) {
			count++
		}
	}
	if host == nil {
		return fail(404, "computer is unavailable")
	}
	if count >= 8 || len(s.db.Devices) >= 1000 {
		return fail(409, "remove an existing device before pairing")
	}
	d := &Device{ID: identity[:24], TokenHash: identity, Name: req.Name, HostID: hostID, UserID: host.UserID, State: "pending", Created: s.now(), Expires: s.now().Add(5 * time.Minute)}
	s.db.Devices[identity] = d
	previous := s.db.Codes[hostID]
	delete(s.db.Codes, hostID)
	if err := s.save(); err != nil {
		delete(s.db.Devices, identity)
		s.db.Codes[hostID] = previous
		return err
	}
	reply(w, 201, map[string]string{"id": d.ID, "state": "pending", "computer": host.Name})
	return nil
}
func (s *Server) approve(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	var req struct {
		ID string `json:"id"`
	}
	if err = body(r, &req); err != nil {
		return err
	}
	for _, d := range s.db.Devices {
		if d.ID == req.ID && d.HostID == host.ID && d.ID != host.ID {
			if d.State != "pending" || !d.Expires.After(s.now()) {
				return fail(409, "pairing request expired or already handled")
			}
			d.State = "approved"
			if err = s.save(); err != nil {
				d.State = "pending"
				return err
			}
			reply(w, 200, map[string]string{"state": "approved"})
			return nil
		}
	}
	return fail(404, "pairing request not found")
}
func (s *Server) enroll(w http.ResponseWriter, r *http.Request, identity string) error {
	d, err := s.device(identity)
	if err != nil {
		return err
	}
	if d.State != "approved" {
		return fail(403, "waiting for computer confirmation")
	}
	nodes, err := s.control.Nodes(r.Context())
	if err != nil {
		return err
	}
	node := findNode(d, nodes)
	if node != nil && (node.Expiry.IsZero() || node.Expiry.After(s.now())) {
		reply(w, 200, map[string]any{"controlUrl": s.controlURL, "hostname": "cr-" + d.ID, "addresses": node.IPs, "registered": true})
		return nil
	}
	usedKey := node != nil && d.Enrollment != nil && node.PreAuthKey.ID == d.Enrollment.ID
	if d.Enrollment == nil || usedKey || !d.Enrollment.Expiration.After(s.now().Add(10*time.Second)) {
		e, err := s.control.Enroll(r.Context(), d.UserID, s.now().Add(2*time.Minute))
		if err != nil {
			return err
		}
		previous := d.Enrollment
		d.Enrollment = &e
		if err = s.save(); err != nil {
			d.Enrollment = previous
			_ = s.control.ExpireEnrollment(r.Context(), e.ID)
			return err
		}
	}
	reply(w, 200, map[string]any{"controlUrl": s.controlURL, "hostname": "cr-" + d.ID, "authKey": d.Enrollment.Key, "expires": d.Enrollment.Expiration, "registered": false})
	return nil
}
func findNode(d *Device, nodes []NetworkNode) *NetworkNode {
	for _, n := range nodes {
		if n.User.ID != d.UserID {
			continue
		}
		if d.NodeID != "" && n.ID == d.NodeID {
			return &n
		}
		if d.Enrollment != nil && n.PreAuthKey.ID == d.Enrollment.ID {
			d.NodeID = n.ID
			return &n
		}
	}
	return nil
}
func (s *Server) status(w http.ResponseWriter, r *http.Request, identity string) error {
	d, err := s.device(identity)
	if err != nil {
		return err
	}
	if d.State == "pending" && !d.Expires.After(s.now()) {
		return fail(410, "pairing request expired")
	}
	nodes, err := s.control.Nodes(r.Context())
	if err != nil {
		return err
	}
	peers := []map[string]any{}
	pending := []map[string]any{}
	for _, p := range s.db.Devices {
		if p.HostID != d.HostID || p.ID == d.ID {
			continue
		}
		if d.ID != d.HostID && p.ID != d.HostID {
			continue
		}
		if p.State == "pending" && p.Expires.After(s.now()) && d.ID == d.HostID {
			pending = append(pending, map[string]any{"id": p.ID, "name": p.Name, "expires": p.Expires})
		}
		if p.State != "approved" {
			continue
		}
		peer := map[string]any{"id": p.ID, "name": p.Name, "addresses": []string{}, "online": false}
		if n := findNode(p, nodes); n != nil && (n.Expiry.IsZero() || n.Expiry.After(s.now())) {
			peer["addresses"], peer["online"] = n.IPs, n.Online
		}
		peers = append(peers, peer)
	}
	addresses := []string{}
	reauthorize := false
	if n := findNode(d, nodes); n != nil {
		addresses = n.IPs
		reauthorize = !n.Expiry.IsZero() && !n.Expiry.After(s.now())
	}
	reply(w, 200, map[string]any{"id": d.ID, "name": d.Name, "state": d.State, "addresses": addresses, "peers": peers, "pending": pending, "reauthorize": reauthorize})
	return nil
}
func (s *Server) revoke(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	var req struct {
		ID string `json:"id"`
	}
	if err = body(r, &req); err != nil {
		return err
	}
	for _, d := range s.db.Devices {
		if d.ID == req.ID && d.HostID == host.ID && d.ID != host.ID {
			previous := d.State
			d.State = "revoked"
			if err = s.save(); err != nil {
				d.State = previous
				return err
			}
			// Invalidate a not-yet-used bootstrap credential as well as an
			// already registered node; deleting only the node allows rejoining.
			if d.Enrollment != nil {
				if err = s.control.ExpireEnrollment(r.Context(), d.Enrollment.ID); err != nil {
					return err
				}
			}
			nodes, err := s.control.Nodes(r.Context())
			if err != nil {
				return err
			}
			if n := findNode(d, nodes); n != nil {
				if err = s.control.DeleteNode(r.Context(), n.ID); err != nil {
					return err
				}
			}
			d.Enrollment = nil
			if err = s.save(); err != nil {
				return err
			}
			reply(w, 200, map[string]string{"state": "revoked"})
			return nil
		}
	}
	return fail(404, "paired phone not found")
}
