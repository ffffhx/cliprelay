package broker

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
)

// A device code is private, stable across restarts and reusable for first
// pairing. It never appears in discovery or status responses.
func (s *Server) deviceCode(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	if value := s.db.DeviceCodes[host.ID]; value != "" {
		reply(w, 200, map[string]string{"value": value})
		return nil
	}
	value, err := s.newPairingCode()
	if err != nil {
		return err
	}
	s.db.DeviceCodes[host.ID] = value
	if err := s.save(); err != nil {
		delete(s.db.DeviceCodes, host.ID)
		return err
	}
	reply(w, 200, map[string]string{"value": value})
	return nil
}

var fixedCode = regexp.MustCompile(`^[0-9]{8}$`)

func codeHash(value string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(value))) }

// Compare-and-swap makes a retry after a lost response return the same new code.
// Existing network enrollments and trusted clients are deliberately untouched.
func (s *Server) rotateDeviceCode(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	var req struct {
		Previous string `json:"previous"`
	}
	if err := body(r, &req); err != nil {
		return err
	}
	if !fixedCode.MatchString(req.Previous) {
		return fail(400, "invalid previous device code")
	}
	previous := s.db.DeviceCodes[host.ID]
	if previous == "" {
		return fail(409, "get a device code before updating it")
	}
	if previous != req.Previous {
		reply(w, 200, map[string]string{"value": previous})
		return nil
	}
	if !s.take(identity+":rotate-device-code", 6) {
		return fail(429, "too many device code updates")
	}
	value, err := s.newPairingCode()
	if err != nil {
		return err
	}
	s.db.DeviceCodes[host.ID] = value
	digest := codeHash(previous)
	s.db.RetiredCodes[digest] = true
	pending := []*Device{}
	for _, device := range s.db.Devices {
		if device.HostID == host.ID && device.ID != host.ID && device.State == "pending" {
			pending = append(pending, device)
			device.State = "revoked"
		}
	}
	if err := s.save(); err != nil {
		s.db.DeviceCodes[host.ID] = previous
		delete(s.db.RetiredCodes, digest)
		for _, device := range pending {
			device.State = "pending"
		}
		return err
	}
	reply(w, 200, map[string]string{"value": value})
	return nil
}

func (s *Server) newPairingCode() (string, error) {
	for {
		n, err := rand.Int(rand.Reader, big.NewInt(100000000))
		if err != nil {
			return "", err
		}
		value := fmt.Sprintf("%08d", n)
		duplicate := s.db.RetiredCodes[codeHash(value)]
		for _, code := range s.db.DeviceCodes {
			if code == value {
				duplicate = true
			}
		}
		for _, code := range s.db.Codes {
			if code.Value == value && code.Expires.After(s.now()) {
				duplicate = true
			}
		}
		if duplicate {
			continue
		}
		return value, nil
	}
}
