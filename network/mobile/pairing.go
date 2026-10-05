package mobile

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type PairingClient struct {
	origin, credential string
	client             *http.Client
}

func NewCredential() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func NewPairingClient(origin, credential string) (*PairingClient, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("pairing endpoint must use HTTPS")
	}
	b, err := base64.RawURLEncoding.DecodeString(credential)
	if err != nil || len(b) != 32 {
		return nil, errors.New("invalid device credential")
	}
	return &PairingClient{origin: strings.TrimRight(origin, "/"), credential: credential, client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Request only accepts the bounded public pairing API. Response bodies may
// include short-lived enrollment credentials and must not be written to logs.
func (c *PairingClient) Request(action, data string) (string, error) {
	method := "POST"
	path := ""
	switch action {
	case "status":
		method = "GET"
		path = "status"
	case "host":
		path = "hosts"
	case "code":
		path = "codes"
	case "claim":
		path = "claims"
	case "approve", "revoke", "enroll":
		path = action
	default:
		return "", errors.New("unknown pairing action")
	}
	if data == "" {
		data = "{}"
	}
	if len(data) > 4096 || !json.Valid([]byte(data)) {
		return "", errors.New("invalid pairing data")
	}
	req, err := http.NewRequest(method, c.origin+"/v1/"+path, bytes.NewBufferString(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.credential)
	resp, err := c.client.Do(req)
	if err != nil {
		return "", errors.New("cannot reach ClipRelay pairing service")
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 128*1024))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var message struct {
			Error string `json:"error"`
		}
		json.Unmarshal(b, &message)
		if message.Error == "" {
			message.Error = "pairing service unavailable"
		}
		return "", fmt.Errorf("%d: %s", resp.StatusCode, message.Error)
	}
	if !json.Valid(b) {
		return "", errors.New("invalid pairing response")
	}
	return string(b), nil
}
