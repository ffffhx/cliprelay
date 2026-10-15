package inputfocus

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

var displayInstance = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type displayTap struct {
	Instance   string
	X, Y       float64
	Stream     uint64
	Generation uint64
	Frame      int64
}

func parseDisplayTap(raw string) (displayTap, bool) {
	var tap displayTap
	q, err := url.ParseQuery(raw)
	if err != nil || len(q) != 6 {
		return tap, false
	}
	for _, key := range []string{"instance", "x", "y", "stream", "generation", "frame"} {
		if len(q[key]) != 1 {
			return tap, false
		}
	}
	tap.Instance = q.Get("instance")
	if !displayInstance.MatchString(tap.Instance) {
		return tap, false
	}
	if tap.X, err = strconv.ParseFloat(q.Get("x"), 64); err != nil {
		return tap, false
	}
	if tap.Y, err = strconv.ParseFloat(q.Get("y"), 64); err != nil {
		return tap, false
	}
	if tap.Stream, err = strconv.ParseUint(q.Get("stream"), 10, 64); err != nil || tap.Stream == 0 {
		return tap, false
	}
	if tap.Generation, err = strconv.ParseUint(q.Get("generation"), 10, 64); err != nil || tap.Generation == 0 {
		return tap, false
	}
	if tap.Frame, err = strconv.ParseInt(q.Get("frame"), 10, 64); err != nil || tap.Frame <= 0 {
		return tap, false
	}
	return tap, !math.IsNaN(tap.X) && !math.IsNaN(tap.Y) && tap.X >= 0 && tap.X <= 1 && tap.Y >= 0 && tap.Y <= 1
}

// Mirror the encoder's aspect-preserving make_port geometry. Do not probe a
// black bar or infer coordinates from the Windows primary monitor. The client's
// rendered frame must already belong to this capture generation.
func mapDisplayTap(state displayState, owner string, tap displayTap) (int, int, bool) {
	if !validDisplayState(state) || state.Instance != tap.Instance || state.Phase != "active" || state.Generation != tap.Generation || state.Capture == nil ||
		math.IsNaN(tap.X) || math.IsNaN(tap.Y) || tap.X < 0 || tap.X > 1 || tap.Y < 0 || tap.Y > 1 {
		return 0, 0, false
	}
	for _, stream := range state.Streams {
		if stream.Owner != owner || stream.ID != tap.Stream || stream.Generation != tap.Generation || stream.FirstFrame <= 0 || tap.Frame < stream.FirstFrame {
			continue
		}
		d := state.Capture
		scale := math.Min(float64(stream.Width)/float64(d.Width), float64(stream.Height)/float64(d.Height))
		x := (tap.X*float64(stream.Width) - (float64(stream.Width)-float64(d.Width)*scale)/2) / scale
		y := (tap.Y*float64(stream.Height) - (float64(stream.Height)-float64(d.Height)*scale)/2) / scale
		if x < 0 || y < 0 || x > float64(d.Width) || y > float64(d.Height) {
			return 0, 0, false
		}
		return d.X + int(math.Min(float64(d.Width-1), math.Floor(x))), d.Y + int(math.Min(float64(d.Height-1), math.Floor(y))), true
	}
	return 0, 0, false
}

func serveDisplayFocus(w http.ResponseWriter, r *http.Request, clients string, provider displayProvider, read func(string) (json.RawMessage, error)) {
	tap, valid := parseDisplayTap(r.URL.RawQuery)
	if r.Method != "GET" || !valid {
		http.Error(w, "invalid display tap", 400)
		return
	}
	digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
	owner := hex.EncodeToString(digest[:])
	state, err := provider(r.Context(), false, nil)
	if err != nil {
		http.Error(w, "display unavailable", 503)
		return
	}
	x, y, mapped := mapDisplayTap(state, owner, tap)
	focus := State{Targeted: true}
	if mapped && paired(clients, r.TLS.PeerCertificates[0].Raw) {
		data, err := read("focus-point:" + strconv.Itoa(x) + ":" + strconv.Itoa(y))
		if err != nil || json.Unmarshal(data, &focus) != nil || len(focus.FocusID) > 128 || !focus.Targeted {
			http.Error(w, "focus unavailable", 503)
			return
		}
		// UI Automation is asynchronous. A capture change while the provider is
		// resolving a control must invalidate the result before it reaches the IME.
		after, err := provider(r.Context(), false, nil)
		x2, y2, current := mapDisplayTap(after, owner, tap)
		if err != nil || !current || x2 != x || y2 != y {
			focus = State{Targeted: true}
		}
	}
	if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
		http.Error(w, "unpaired", 403)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(focus)
}
