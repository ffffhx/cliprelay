// Package broker implements ClipRelay's accountless device pairing. Headscale
// administrative credentials remain on the server and never enter client builds.
package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Enrollment struct {
	ID         string    `json:"id"`
	Key        string    `json:"key"`
	Expiration time.Time `json:"expiration"`
}
type NetworkNode struct {
	ID     string    `json:"id"`
	IPs    []string  `json:"ipAddresses"`
	Online bool      `json:"online"`
	Expiry time.Time `json:"expiry"`
	User   struct {
		ID string `json:"id"`
	} `json:"user"`
	PreAuthKey struct {
		ID string `json:"id"`
	} `json:"preAuthKey"`
}

type Control interface {
	CreateUser(context.Context, string) (string, error)
	Enroll(context.Context, string, time.Time) (Enrollment, error)
	Nodes(context.Context) ([]NetworkNode, error)
	DeleteNode(context.Context, string) error
	ExpireEnrollment(context.Context, string) error
}

type Headscale struct {
	URL, APIKey string
	Client      *http.Client
}

func (h *Headscale) request(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.URL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.APIKey)
	req.Header.Set("Content-Type", "application/json")
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("coordination service unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Do not expose backend bodies, which may contain auth keys or user data.
		return fmt.Errorf("coordination service returned %d", resp.StatusCode)
	}
	if output == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(output)
}
func (h *Headscale) CreateUser(ctx context.Context, name string) (string, error) {
	// Recover if the previous attempt created a user but could not commit the
	// broker database (for example after a disk-full error).
	var existing struct {
		Users []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"users"`
	}
	if err := h.request(ctx, "GET", "/api/v1/user", nil, &existing); err != nil {
		return "", err
	}
	for _, u := range existing.Users {
		if u.Name == name {
			return u.ID, nil
		}
	}
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	err := h.request(ctx, "POST", "/api/v1/user", map[string]string{"name": name}, &out)
	if err == nil && out.User.ID == "" {
		err = errors.New("coordination service omitted user ID")
	}
	return out.User.ID, err
}
func (h *Headscale) Enroll(ctx context.Context, user string, expiry time.Time) (Enrollment, error) {
	var out struct {
		PreAuthKey Enrollment `json:"preAuthKey"`
	}
	err := h.request(ctx, "POST", "/api/v1/preauthkey", map[string]any{"user": user, "reusable": false, "ephemeral": false, "expiration": expiry.UTC().Format(time.RFC3339)}, &out)
	if err == nil && (out.PreAuthKey.ID == "" || out.PreAuthKey.Key == "") {
		err = errors.New("coordination service omitted enrollment")
	}
	return out.PreAuthKey, err
}
func (h *Headscale) Nodes(ctx context.Context) ([]NetworkNode, error) {
	var out struct {
		Nodes []NetworkNode `json:"nodes"`
	}
	err := h.request(ctx, "GET", "/api/v1/node", nil, &out)
	return out.Nodes, err
}
func (h *Headscale) DeleteNode(ctx context.Context, id string) error {
	return h.request(ctx, "DELETE", "/api/v1/node/"+id, nil, nil)
}

func (h *Headscale) ExpireEnrollment(ctx context.Context, id string) error {
	return h.request(ctx, "POST", "/api/v1/preauthkey/expire", map[string]string{"id": id}, nil)
}
