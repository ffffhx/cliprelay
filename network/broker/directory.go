package broker

import (
	"net/http"
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

// Public enumeration and address-free claims are retired. LAN discovery stays
// local; an unpaired Internet client must prove possession of the device code.
func (s *Server) discover(w http.ResponseWriter, r *http.Request, identity string) error {
	reply(w, 200, map[string]any{"devices": []presence{}})
	return nil
}
func (s *Server) claimDiscovered(w http.ResponseWriter, r *http.Request, identity string) error {
	return fail(403, "device code required")
}
