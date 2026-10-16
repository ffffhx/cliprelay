package inputfocus

import (
	"crypto/x509"
	"errors"
	"sync"
)

// EngineAccess supplies a fresh local admin credential snapshot. It is provided
// by the owning host process, never by a remote request or renderer. The caller
// must cancel and join service requests before releasing its credential owner.
type EngineAccess func() (password string, certificateDER []byte, err error)

var errEngineAccessUnavailable = errors.New("engine credentials unavailable")

// MemoryEngineAccess holds credentials received over an owned local channel.
// It never reads or writes service.json, and Close refuses subsequent reads.
type MemoryEngineAccess struct {
	mu          sync.Mutex
	password    string
	certificate []byte
	closed      bool
}

// NewMemoryEngineAccess validates and copies the fixed engine identity. PEM
// decoding and decryption belong to the owning application's private state layer.
func NewMemoryEngineAccess(password string, certificateDER []byte) (*MemoryEngineAccess, error) {
	if len(password) < 16 || len(password) > 1024 || len(certificateDER) == 0 || len(certificateDER) > 64*1024 {
		return nil, errEngineAccessUnavailable
	}
	if _, err := x509.ParseCertificate(certificateDER); err != nil {
		return nil, errEngineAccessUnavailable
	}
	return &MemoryEngineAccess{password: password, certificate: append([]byte(nil), certificateDER...)}, nil
}

// Read returns independent certificate bytes so a request cannot mutate the pin
// retained by the owner. Errors contain no credential data or state path.
func (a *MemoryEngineAccess) Read() (string, []byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.password == "" || len(a.certificate) == 0 {
		return "", nil, errEngineAccessUnavailable
	}
	return a.password, append([]byte(nil), a.certificate...), nil
}

// Close releases retained credentials and is safe to call repeatedly. It does
// not erase copies held by existing requests; their context owns cancellation.
func (a *MemoryEngineAccess) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	a.password = ""
	clear(a.certificate)
	a.certificate = nil
}

func fileEngineAccess(dir string) EngineAccess {
	return func() (string, []byte, error) { return readEngineAccess(dir) }
}
