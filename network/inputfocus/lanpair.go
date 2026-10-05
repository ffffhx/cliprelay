package inputfocus

// LAN pairing bootstraps the existing Sunshine certificate exchange. It does
// not authorize clients itself: only the installed service's local control pipe
// can create an approval in the ACL-protected directory. The PIN stays inside
// TLS and process memory. Both screens compare a code bound to BOTH TLS keys.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var pairNonce = regexp.MustCompile(`^[0-9a-f]{32}$`)
var pairPIN = regexp.MustCompile(`^[0-9]{4}$`)

type lanRequest struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Verification string `json:"verification"`
	Expires      int64  `json:"expires"`
	pin          string
	client       []byte
	cancel       context.CancelFunc
}

type lanPairer struct {
	mu         sync.Mutex
	dir        string
	serverCert []byte
	requests   map[string]*lanRequest
	engine     func(context.Context, string, string, any) ([]byte, error)
	ctx        context.Context
}

func newLANPairer(ctx context.Context, dir string, cert tls.Certificate) *lanPairer {
	p := &lanPairer{ctx: ctx, dir: filepath.Join(dir, "lan-pairing"), serverCert: cert.Certificate[0], requests: make(map[string]*lanRequest)}
	// The admin API stays loopback-only and uses the engine's pinned certificate.
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12,
		InsecureSkipVerify: true, // exact certificate comparison below, including self-signed hosts
		VerifyConnection: func(s tls.ConnectionState) error {
			if len(s.PeerCertificates) != 1 || !bytes.Equal(s.PeerCertificates[0].Raw, p.serverCert) {
				return errors.New("host certificate changed")
			}
			return nil
		}}}
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	p.engine = func(ctx context.Context, method, path string, body any) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(dir, "service.json"))
		if err != nil {
			return nil, err
		}
		var config struct {
			Password string `json:"adminPassword"`
		}
		if json.Unmarshal(b, &config) != nil || config.Password == "" {
			return nil, errors.New("missing local credential")
		}
		var data []byte
		if body != nil {
			data, err = json.Marshal(body)
			if err != nil {
				return nil, err
			}
		}
		r, err := http.NewRequestWithContext(ctx, method, "https://127.0.0.1:48790"+path, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		r.SetBasicAuth("cliprelay", config.Password)
		r.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(r)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, errors.New("local pairing API unavailable")
		}
		b, err = io.ReadAll(io.LimitReader(resp.Body, 32769))
		if len(b) > 32768 {
			return nil, errors.New("invalid local response")
		}
		return b, err
	}
	return p
}

func verification(server, client []byte, nonce string) (string, string) {
	h := sha256.New()
	h.Write([]byte("cliprelay-lan-pair-v1\n"))
	h.Write(server)
	h.Write(client)
	h.Write([]byte(nonce))
	digest := h.Sum(nil)
	code := strings.ToUpper(hex.EncodeToString(digest[:6]))
	return hex.EncodeToString(digest[:16]), code[:4] + " " + code[4:8] + " " + code[8:]
}

func (p *lanPairer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 {
		http.Error(w, "client certificate required", 403)
		return
	}
	clientCert := r.TLS.PeerCertificates[0].Raw
	if r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v1/pair/") {
		id := strings.TrimPrefix(r.URL.Path, "/v1/pair/")
		p.mu.Lock()
		request := p.requests[id]
		p.mu.Unlock()
		if request == nil || !bytes.Equal(request.client, clientCert) {
			http.Error(w, "unknown request", 404)
			return
		}
		request.cancel()
		w.WriteHeader(204)
		return
	}
	if r.Method != "POST" || r.URL.Path != "/v1/pair" {
		http.NotFound(w, r)
		return
	}
	mediaType, _, mediaError := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaError != nil || mediaType != "application/json" {
		http.Error(w, "JSON required", 415)
		return
	}
	var input struct {
		Nonce string `json:"nonce"`
		Name  string `json:"name"`
		PIN   string `json:"pin"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || !pairNonce.MatchString(input.Nonce) || !pairPIN.MatchString(input.PIN) ||
		len(input.Name) == 0 || len(input.Name) > 128 || strings.ContainsAny(input.Name, "\r\n\x00") {
		http.Error(w, "invalid request", 400)
		return
	}
	id, code := verification(p.serverCert, clientCert, input.Nonce)
	p.mu.Lock()
	if existing := p.requests[id]; existing != nil {
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(existing)
		return
	}
	if len(p.requests) >= 8 {
		p.mu.Unlock()
		http.Error(w, "too many requests", 429)
		return
	}
	for _, existing := range p.requests {
		if bytes.Equal(existing.client, clientCert) {
			p.mu.Unlock()
			http.Error(w, "pairing already pending", 409)
			return
		}
	}
	ctx, cancel := context.WithTimeout(p.ctx, 2*time.Minute)
	request := &lanRequest{ID: id, Name: input.Name, Verification: code, Expires: time.Now().Add(2 * time.Minute).Unix(), pin: input.PIN, client: append([]byte(nil), clientCert...), cancel: cancel}
	data, _ := json.Marshal(request)
	err := os.MkdirAll(p.dir, 0700)
	if err == nil {
		_ = os.Remove(filepath.Join(p.dir, id+".approved"))
		err = os.WriteFile(filepath.Join(p.dir, id+".json"), data, 0600)
	}
	if err != nil {
		p.mu.Unlock()
		cancel()
		http.Error(w, "pairing unavailable", 503)
		return
	}
	p.requests[id] = request
	p.mu.Unlock()
	go p.run(ctx, request)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(request)
}

func (p *lanPairer) run(ctx context.Context, request *lanRequest) {
	defer func() {
		request.cancel()
		p.mu.Lock()
		delete(p.requests, request.ID)
		_ = os.Remove(filepath.Join(p.dir, request.ID+".json"))
		_ = os.Remove(filepath.Join(p.dir, request.ID+".approved"))
		p.mu.Unlock()
	}()
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if _, err := os.Stat(filepath.Join(p.dir, request.ID+".approved")); err != nil {
			continue
		}
		b, err := p.engine(ctx, "GET", "/api/pin", nil)
		if err != nil {
			continue
		}
		var pending struct {
			Pairings []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"pairings"`
		}
		if json.Unmarshal(b, &pending) != nil {
			continue
		}
		for _, entry := range pending.Pairings {
			// The temporary name and unique ID isolate this handshake from other
			// phones. A forged pending request cannot complete the PIN proof or
			// client-key signature, and the phone also checks the server TLS key.
			if entry.Name != "ClipRelay-"+request.ID || !pairNonce.MatchString(entry.ID) {
				continue
			}
			_, _ = p.engine(ctx, "POST", "/api/pin", map[string]string{"pairing_id": entry.ID, "pin": request.pin, "name": request.Name})
			return
		}
	}
}

func serveLANPairing(ctx context.Context, dir string, cert tls.Certificate) error {
	p := newLANPairer(ctx, dir, cert)
	server := &http.Server{Addr: ":48792", Handler: p, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 4 * time.Second, WriteTimeout: 4 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAnyClientCert},
		ErrorLog:  nil}
	// Bind separately so an occupied port fails before starting a permanent waiter.
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("LAN pairing listener: %w", err)
	}
	go func() { <-ctx.Done(); server.Close() }()
	return server.ServeTLS(listener, "", "")
}
