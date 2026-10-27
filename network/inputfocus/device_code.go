package inputfocus

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"time"
)

var deviceCodePattern = regexp.MustCompile(`^[0-9]{8}$`)

type codeAttempt struct {
	until time.Time
	count int
}

func deviceAccessFile(file string) func() (bool, string, error) {
	return func() (bool, string, error) {
		data, err := readSmallFile(file, 64*1024)
		if err != nil {
			return false, "", err
		}
		var policy struct {
			Required bool   `json:"requireDeviceCode"`
			Code     string `json:"deviceCode"`
			Updating bool   `json:"deviceCodeUpdating"`
		}
		if json.Unmarshal(data, &policy) != nil || policy.Updating || (policy.Required && !deviceCodePattern.MatchString(policy.Code)) {
			return false, "", errors.New("invalid device access policy")
		}
		return policy.Required, policy.Code, nil
	}
}

func (p *lanPairer) checkDeviceCode(w http.ResponseWriter, r *http.Request, certificate []byte, code string) bool {
	if p.deviceAccess == nil {
		return true
	}
	required, expected, err := p.deviceAccess()
	deny := func(status int, code string) bool {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
		return false
	}
	if paired(filepath.Join(filepath.Dir(p.dir), "clients.json"), certificate) {
		return true
	}
	if err != nil {
		return deny(503, "DEVICE_ACCESS_UNAVAILABLE")
	}
	if !required {
		return true
	}
	if code == "" {
		return deny(403, "DEVICE_CODE_REQUIRED")
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		host = ip.Mask(net.CIDRMask(64, 128)).String()
	}
	p.mu.Lock()
	now := time.Now()
	if p.codeAttempts == nil {
		p.codeAttempts = map[string]codeAttempt{}
	}
	for key, attempt := range p.codeAttempts {
		if !now.Before(attempt.until) {
			delete(p.codeAttempts, key)
		}
	}
	attempt := p.codeAttempts[host]
	if attempt.count >= 6 || (attempt.count == 0 && len(p.codeAttempts) >= 256) {
		p.mu.Unlock()
		return deny(429, "DEVICE_CODE_RATE_LIMIT")
	}
	if attempt.count == 0 {
		attempt.until = now.Add(time.Minute)
	}
	attempt.count++
	p.codeAttempts[host] = attempt
	p.mu.Unlock()
	if !deviceCodePattern.MatchString(code) || subtle.ConstantTimeCompare([]byte(code), []byte(expected)) != 1 {
		return deny(403, "DEVICE_CODE_INVALID")
	}
	return true
}
