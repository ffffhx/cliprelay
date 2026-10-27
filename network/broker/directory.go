package broker

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

// Presence is leased, never restored from disk: an exited app or a restarted
// directory cannot leave an unattended computer publicly advertised.
type presence struct {
	ID          string    `json:"id"`
	DeviceID    string    `json:"deviceId"`
	Name        string    `json:"name"`
	Platform    string    `json:"platform"`
	Connectable bool      `json:"connectable"`
	Expires     time.Time `json:"-"`
}

func (s *Server) publishPresence(w http.ResponseWriter, r *http.Request, identity string) error {
	host, err := s.host(identity)
	if err != nil {
		return err
	}
	var req struct {
		DeviceID     string `json:"deviceId"`
		Name         string `json:"name"`
		Platform     string `json:"platform"`
		Discoverable bool   `json:"discoverable"`
		Connectable  bool   `json:"connectable"`
	}
	if err := body(r, &req); err != nil {
		return err
	}
	if !nameOK(req.Name) || len(req.DeviceID) < 1 || len(req.DeviceID) > 64 || strings.ContainsAny(req.DeviceID, "\r\n\x00") || (req.Platform != "windows" && req.Platform != "macos") {
		return fail(400, "invalid device presence")
	}
	if s.directory == nil {
		s.directory = map[string]presence{}
	}
	if req.Discoverable {
		s.directory[host.ID] = presence{ID: host.ID, DeviceID: req.DeviceID, Name: req.Name, Platform: req.Platform, Connectable: req.Connectable, Expires: s.now().Add(15 * time.Second)}
	} else {
		delete(s.directory, host.ID)
	}
	reply(w, 200, map[string]bool{"published": req.Discoverable})
	return nil
}

func (s *Server) discover(w http.ResponseWriter, r *http.Request, identity string) error {
	devices := []presence{}
	for id, p := range s.directory {
		if !p.Expires.After(s.now()) {
			delete(s.directory, id)
			continue
		}
		if id != identity[:24] {
			devices = append(devices, p)
		}
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	reply(w, 200, map[string]any{"devices": devices})
	return nil
}

// The host explicitly publishes both discovery and connection permission.
// Each viewer still receives its own revocable identity in that host's network.
// Existing pairing-code endpoints retain their original approval semantics.
func (s *Server) claimDiscovered(w http.ResponseWriter, r *http.Request, identity string) error {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := body(r, &req); err != nil {
		return err
	}
	if !nameOK(req.Name) {
		return fail(400, "invalid device name")
	}
	p, ok := s.directory[req.ID]
	if !ok || !p.Expires.After(s.now()) || !p.Connectable {
		return fail(404, "computer is not accepting connections")
	}
	if !s.take(identity+":directory-claim", 6) {
		return fail(429, "too many connection attempts")
	}
	if existing := s.db.Devices[identity]; existing != nil {
		if existing.HostID != req.ID || existing.State != "approved" || existing.ID == existing.HostID {
			return fail(409, "device already has a pairing record")
		}
		reply(w, 200, map[string]string{"id": existing.ID, "state": "approved", "computer": p.Name, "hostId": req.ID})
		return nil
	}
	var host *Device
	count := 0
	for _, d := range s.db.Devices {
		if d.ID == req.ID && d.ID == d.HostID && d.State == "approved" {
			host = d
		}
		if d.HostID == req.ID && d.ID != req.ID && d.State != "revoked" && (d.State != "pending" || d.Expires.After(s.now())) {
			count++
		}
	}
	if host == nil {
		return fail(404, "computer is unavailable")
	}
	if count >= 8 || len(s.db.Devices) >= 1000 {
		return fail(409, "computer device capacity reached")
	}
	d := &Device{ID: identity[:24], TokenHash: identity, Name: req.Name, HostID: host.ID, UserID: host.UserID, State: "approved", Created: s.now()}
	s.db.Devices[identity] = d
	if err := s.save(); err != nil {
		delete(s.db.Devices, identity)
		return err
	}
	reply(w, 201, map[string]string{"id": d.ID, "state": "approved", "computer": p.Name, "hostId": host.ID})
	return nil
}
