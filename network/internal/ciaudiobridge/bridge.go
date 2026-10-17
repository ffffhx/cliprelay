// Package ciaudiobridge is a disposable CI transport for independent audio
// environments. It is not linked into a shipping ClipRelay entry point. A
// public WebSocket route carries an inner mutually authenticated TLS stream;
// only authenticated peers can select an explicitly allowed loopback socket.
package ciaudiobridge

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const MaxDatagram = 65507
const MaxConnections = 16
const serverName = "cliprelay-audio-ci.invalid"

// TLS owns orderly EOF. The outer route must not wait for a WebSocket close
// handshake from a peer that has already rejected/closed the inner stream.
type socket struct {
	net.Conn
	ws *websocket.Conn
}

func (s *socket) Close() error { return s.ws.CloseNow() }
func byteStream(ctx context.Context, ws *websocket.Conn) net.Conn {
	conn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	ws.SetReadLimit(128 * 1024)
	return &socket{Conn: conn, ws: ws}
}

// Identity returns a fresh, short-lived identity. Only certPEM is suitable for
// exchange between jobs; keyPEM stays with the process/job that generated it.
func Identity() (certPEM, keyPEM []byte, err error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: serverName},
		DNSNames: []string{serverName}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, public, private)
	if err != nil {
		return nil, nil, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), nil
}

func TLSConfig(own tls.Certificate, peerPEM []byte, server bool) (*tls.Config, error) {
	if len(own.Certificate) != 1 || own.PrivateKey == nil || len(peerPEM) > 4096 {
		return nil, errors.New("invalid identity")
	}
	block, rest := pem.Decode(peerPEM)
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("invalid peer")
	}
	peer, err := x509.ParseCertificate(block.Bytes)
	if err != nil || peer.IsCA || peer.NotAfter.Sub(peer.NotBefore) > 62*time.Minute {
		return nil, errors.New("invalid peer")
	}
	if err = peer.CheckSignature(peer.SignatureAlgorithm, peer.RawTBSCertificate, peer.Signature); err != nil {
		return nil, errors.New("invalid peer signature")
	}
	pool := x509.NewCertPool()
	pool.AddCert(peer)
	config := &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13,
		Certificates: []tls.Certificate{own}, RootCAs: pool, ServerName: serverName,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 || !bytes.Equal(state.PeerCertificates[0].Raw, peer.Raw) {
				return errors.New("peer pin mismatch")
			}
			return nil
		}}
	if server {
		config.ClientAuth = tls.RequireAndVerifyClientCert
		config.ClientCAs = pool
	}
	return config, nil
}

type Target struct {
	Network string
	Port    int
}

func (target Target) address() (string, error) {
	if (target.Network != "tcp" && target.Network != "udp") || target.Port < 1 || target.Port > 65535 {
		return "", errors.New("invalid target")
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(target.Port)), nil
}

type Counters struct{ Authenticated, Rejected, BackendDials, Active int64 }
type Server struct {
	tls           *tls.Config
	targets       map[Target]bool
	active        atomic.Int64
	authenticated atomic.Int64
	rejected      atomic.Int64
	dials         atomic.Int64
}

func NewServer(config *tls.Config, targets []Target) (*Server, error) {
	if config == nil || config.MinVersion != tls.VersionTLS13 || config.ClientAuth != tls.RequireAndVerifyClientCert ||
		config.VerifyConnection == nil || config.InsecureSkipVerify || len(targets) == 0 || len(targets) > 16 {
		return nil, errors.New("invalid server")
	}
	s := &Server{tls: config.Clone(), targets: make(map[Target]bool)}
	for _, target := range targets {
		if _, err := target.address(); err != nil {
			return nil, err
		}
		s.targets[target] = true
	}
	return s, nil
}

func (s *Server) Counters() Counters {
	return Counters{s.authenticated.Load(), s.rejected.Load(), s.dials.Load(), s.active.Load()}
}

// Serve owns listener, accepts loopback only, and waits for all hijacked sockets
// on cancellation. http.Server.Close alone does not close WebSocket sessions.
func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !address.IP.IsLoopback() {
		listener.Close()
		return errors.New("non-loopback listener")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	var workers sync.WaitGroup
	closing := false
	slots := make(chan struct{}, MaxConnections)
	server := &http.Server{ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192,
		ErrorLog: log.New(io.Discard, "", 0)}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-ClipRelay-Fixture", "audio-bridge-v1")
		if r.Method != http.MethodGet || r.URL.Path != "/bridge" || r.URL.RawQuery != "" {
			http.Error(w, "unavailable", http.StatusNotFound)
			return
		}
		mu.Lock()
		if closing {
			mu.Unlock()
			http.Error(w, "closed", http.StatusServiceUnavailable)
			return
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
		default:
			mu.Unlock()
			s.rejected.Add(1)
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		mu.Unlock()
		s.active.Add(1)
		defer func() { s.active.Add(-1); <-slots; workers.Done() }()
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			s.rejected.Add(1)
			return
		}
		defer ws.CloseNow()
		raw := byteStream(ctx, ws)
		secure := tls.Server(raw, s.tls)
		defer secure.Close()
		secure.SetDeadline(time.Now().Add(5 * time.Second))
		if err := secure.HandshakeContext(ctx); err != nil {
			s.rejected.Add(1)
			return
		}
		var header [3]byte
		if _, err := io.ReadFull(secure, header[:]); err != nil {
			s.rejected.Add(1)
			return
		}
		target := Target{Port: int(binary.BigEndian.Uint16(header[1:]))}
		if header[0] == 1 {
			target.Network = "tcp"
		} else if header[0] == 2 {
			target.Network = "udp"
		}
		if !s.targets[target] {
			s.rejected.Add(1)
			return
		}
		s.authenticated.Add(1)
		address, _ := target.address()
		dialer := net.Dialer{Timeout: 3 * time.Second}
		backend, err := dialer.DialContext(ctx, target.Network+"4", address)
		if err != nil {
			return
		}
		s.dials.Add(1)
		defer backend.Close()
		if _, err := secure.Write([]byte{1}); err != nil {
			return
		}
		secure.SetDeadline(time.Time{})
		stop := context.AfterFunc(ctx, func() { backend.Close(); raw.Close() })
		defer stop()
		if target.Network == "udp" {
			relayPackets(ctx, backend, &DatagramConn{Conn: secure})
		} else {
			relayTCP(backend, secure)
		}
	})
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		closing = true
		mu.Unlock()
		server.Close()
	})
	err := server.Serve(listener)
	wasCanceled := ctx.Err() != nil
	cancel()
	stop()
	mu.Lock()
	closing = true
	mu.Unlock()
	server.Close()
	workers.Wait()
	if errors.Is(err, http.ErrServerClosed) || wasCanceled {
		return nil
	}
	return err
}

func relayTCP(left, right net.Conn) {
	done := make(chan struct{})
	copyHalf := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if err != nil {
			left.Close()
			right.Close()
			return
		}
		if half, ok := dst.(interface{ CloseWrite() error }); ok {
			half.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go func() { defer close(done); copyHalf(left, right) }()
	copyHalf(right, left)
	<-done
}

func relayPackets(ctx context.Context, left, right net.Conn) {
	copyPackets := func(dst, src net.Conn) {
		buffer := make([]byte, MaxDatagram)
		for ctx.Err() == nil {
			src.SetReadDeadline(time.Now().Add(60 * time.Second))
			n, err := src.Read(buffer)
			if err != nil {
				return
			}
			dst.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if written, err := dst.Write(buffer[:n]); err != nil || written != n {
				return
			}
		}
	}
	done := make(chan struct{})
	go func() { defer close(done); copyPackets(left, right); left.Close(); right.Close() }()
	copyPackets(right, left)
	left.Close()
	right.Close()
	<-done
}

type Client struct {
	Context context.Context
	URL     string
	TLS     *tls.Config
}

func (c Client) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if c.Context == nil || c.TLS == nil || c.TLS.InsecureSkipVerify || c.TLS.MinVersion != tls.VersionTLS13 || c.TLS.VerifyConnection == nil {
		return nil, errors.New("invalid client")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.User != nil || u.Path != "/bridge" || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "wss" && !(u.Scheme == "ws" && net.ParseIP(u.Hostname()).IsLoopback())) {
		return nil, errors.New("invalid route")
	}
	host, portText, err := net.SplitHostPort(address)
	port, numberErr := strconv.Atoi(portText)
	if err != nil || numberErr != nil || host != "127.0.0.1" {
		return nil, errors.New("invalid endpoint")
	}
	target := Target{network, port}
	if _, err := target.address(); err != nil {
		return nil, err
	}
	ws, _, err := websocket.Dial(ctx, c.URL, &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, errors.New("route unavailable")
	}
	stopDial := context.AfterFunc(ctx, func() { ws.CloseNow() })
	defer stopDial()
	raw := byteStream(c.Context, ws)
	secure := tls.Client(raw, c.TLS)
	success := false
	defer func() {
		if !success {
			ws.CloseNow()
		}
	}()
	secure.SetDeadline(time.Now().Add(5 * time.Second))
	if err = secure.HandshakeContext(ctx); err != nil {
		return nil, errors.New("peer authentication failed")
	}
	header := []byte{1, byte(port >> 8), byte(port)}
	if network == "udp" {
		header[0] = 2
	}
	if _, err = secure.Write(header); err != nil {
		return nil, errors.New("selection failed")
	}
	var ack [1]byte
	if _, err = io.ReadFull(secure, ack[:]); err != nil || ack[0] != 1 {
		return nil, errors.New("target unavailable")
	}
	if ctx.Err() != nil {
		return nil, errors.New("dial canceled")
	}
	secure.SetDeadline(time.Time{})
	success = true
	if network == "udp" {
		return &DatagramConn{Conn: secure}, nil
	}
	return secure, nil
}

// DatagramConn preserves packet boundaries over the authenticated byte stream.
// All writes include a length; malformed/short reads close the stream rather
// than letting a subsequent packet be interpreted at the wrong offset.
type DatagramConn struct {
	net.Conn
	readMu, writeMu sync.Mutex
}

func (d *DatagramConn) Read(buffer []byte) (int, error) {
	d.readMu.Lock()
	defer d.readMu.Unlock()
	var header [4]byte
	if _, err := io.ReadFull(d.Conn, header[:]); err != nil {
		return 0, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size > MaxDatagram || int(size) > len(buffer) {
		d.Conn.Close()
		return 0, io.ErrShortBuffer
	}
	n, err := io.ReadFull(d.Conn, buffer[:size])
	if err != nil {
		d.Conn.Close()
	}
	return n, err
}

func (d *DatagramConn) Write(buffer []byte) (int, error) {
	if len(buffer) > MaxDatagram {
		return 0, io.ErrShortBuffer
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	packet := make([]byte, 4+len(buffer))
	binary.BigEndian.PutUint32(packet, uint32(len(buffer)))
	copy(packet[4:], buffer)
	for len(packet) > 0 {
		n, err := d.Conn.Write(packet)
		if err != nil || n == 0 {
			d.Conn.Close()
			if err == nil {
				err = io.ErrShortWrite
			}
			return 0, err
		}
		packet = packet[n:]
	}
	return len(buffer), nil
}
