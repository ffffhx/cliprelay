package inputfocus

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var errDisplayUnsupported = errors.New("display control unsupported")

type displayGeometry struct {
	ID            string `json:"id"`
	X             int    `json:"x"`
	Y             int    `json:"y"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	DesktopX      int    `json:"desktopX"`
	DesktopY      int    `json:"desktopY"`
	DesktopWidth  int    `json:"desktopWidth"`
	DesktopHeight int    `json:"desktopHeight"`
}

type displayAudio struct {
	Capture    string `json:"capture"`
	Generation uint64 `json:"generation"`
	Ready      bool   `json:"ready"`
}

type displayStream struct {
	Owner      string        `json:"owner,omitempty"`
	ID         uint64        `json:"id"`
	Generation uint64        `json:"generation"`
	Width      int           `json:"width"`
	Height     int           `json:"height"`
	FirstFrame int64         `json:"firstFrame"`
	Audio      *displayAudio `json:"audio,omitempty"`
}

type displayState struct {
	Protocol   int              `json:"protocol"`
	Instance   string           `json:"instance"`
	Supported  bool             `json:"supported"`
	Revision   uint64           `json:"revision"`
	Generation uint64           `json:"generation"`
	Phase      string           `json:"phase"`
	Displays   []string         `json:"displays"`
	Capture    *displayGeometry `json:"capture"`
	Streams    []displayStream  `json:"streams"`
	RequestID  uint64           `json:"requestId"`
	Requested  string           `json:"requested"`
	Result     string           `json:"result"`
	Error      string           `json:"error"`
	Accepted   bool             `json:"accepted"`
	Outcome    string           `json:"outcome,omitempty"`
	Shared     bool             `json:"shared"`
}

type displaySelection struct {
	Instance string `json:"instance"`
	Display  string `json:"display"`
	Revision uint64 `json:"revision"`
	Stream   uint64 `json:"stream"`
}

type displayProvider func(context.Context, bool, *displaySelection) (displayState, error)

// The endpoint and credentials are host-owned constants. This client cannot be
// used as an arbitrary URL proxy, and never follows a redirect carrying Basic auth.
func engineDisplayProvider(dir string) displayProvider {
	return func(ctx context.Context, refresh bool, selection *displaySelection) (displayState, error) {
		password, certificate, err := readEngineAccess(dir)
		if err != nil {
			return displayState{}, err
		}
		return requestEngineDisplay(ctx, "https://127.0.0.1:48790", password, certificate, refresh, selection)
	}
}

func readEngineAccess(dir string) (string, []byte, error) {
	settings, err := readSmallFile(filepath.Join(dir, "service.json"), 64*1024)
	if err != nil {
		return "", nil, err
	}
	var config struct {
		AdminPassword string `json:"adminPassword"`
	}
	if json.Unmarshal(settings, &config) != nil || len(config.AdminPassword) < 16 || len(config.AdminPassword) > 1024 {
		return "", nil, errors.New("engine credentials unavailable")
	}
	certificate, err := readSmallFile(filepath.Join(dir, "cacert.pem"), 64*1024)
	if err != nil {
		return "", nil, err
	}
	block, _ := pem.Decode(certificate)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", nil, errors.New("engine certificate unavailable")
	}
	return config.AdminPassword, block.Bytes, nil
}

func readSmallFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, errors.New("state file too large")
	}
	return b, err
}

func requestEngineDisplay(ctx context.Context, endpoint, password string, certificate []byte, refresh bool, selection *displaySelection) (displayState, error) {
	var state displayState
	path := "/api/cliprelay/displays"
	var payload []byte
	if selection != nil {
		payload, _ = json.Marshal(struct {
			Instance string `json:"instance"`
			Display  string `json:"display"`
			Revision uint64 `json:"revision"`
		}{selection.Instance, selection.Display, selection.Revision})
	} else if refresh {
		path += "?refresh=1"
	}
	body, err := requestEngineJSON(ctx, endpoint, password, certificate, path, payload)
	if err != nil {
		return state, err
	}
	if json.Unmarshal(body, &state) != nil || !validDisplayState(state) {
		return displayState{}, errors.New("invalid engine display state")
	}
	state.Supported = true
	return state, nil
}

func requestEngineJSON(ctx context.Context, endpoint, password string, certificate []byte, path string, payload []byte) ([]byte, error) {
	transport := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 3 * time.Second,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12,
			InsecureSkipVerify: true, // exact certificate pin below replaces CA/hostname trust
			VerifyConnection: func(connection tls.ConnectionState) error {
				if len(certificate) == 0 || len(connection.PeerCertificates) != 1 || !bytes.Equal(connection.PeerCertificates[0].Raw, certificate) {
					return errors.New("engine certificate mismatch")
				}
				return nil
			}}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	method := "GET"
	if payload != nil {
		method = "POST"
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.SetBasicAuth("cliprelay", password)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return nil, errDisplayUnsupported
	}
	if response.StatusCode != 200 {
		return nil, errors.New("engine control unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		return nil, errors.New("invalid engine response")
	}
	return body, nil
}

func validDisplayState(state displayState) bool {
	if state.Protocol != 1 || !displayInstance.MatchString(state.Instance) || len(state.Displays) > 64 || len(state.Streams) > 64 || len(state.Requested) > 256 || len(state.Error) > 64 || len(state.Result) > 16 || len(state.Outcome) > 32 {
		return false
	}
	switch state.Phase {
	case "idle", "starting", "switching", "active":
	default:
		return false
	}
	for _, id := range state.Displays {
		if id == "" || len(id) > 256 || strings.ContainsAny(id, "\x00\r\n") {
			return false
		}
	}
	for _, stream := range state.Streams {
		if !fileHash.MatchString(stream.Owner) || stream.ID == 0 || stream.Width < 1 || stream.Height < 1 || stream.Width > 65536 || stream.Height > 65536 || stream.FirstFrame < 0 {
			return false
		}
		if audio := stream.Audio; audio != nil {
			switch audio.Capture {
			case "":
				if audio.Generation != 0 || audio.Ready {
					return false
				}
			case "endpoint":
				if audio.Generation == 0 || audio.Ready {
					return false
				}
			case "process":
				if audio.Generation == 0 {
					return false
				}
			default:
				return false
			}
		}
	}
	if d := state.Capture; d != nil {
		if len(d.ID) < 1 || len(d.ID) > 256 || d.Width < 1 || d.Height < 1 || d.Width > 65536 || d.Height > 65536 ||
			d.DesktopWidth < d.Width || d.DesktopHeight < d.Height || d.DesktopWidth > 262144 || d.DesktopHeight > 262144 {
			return false
		}
		for _, n := range []int{d.X, d.Y, d.DesktopX, d.DesktopY} {
			if n < -1048576 || n > 1048576 {
				return false
			}
		}
		if d.X < d.DesktopX || d.Y < d.DesktopY || d.X+d.Width > d.DesktopX+d.DesktopWidth || d.Y+d.Height > d.DesktopY+d.DesktopHeight {
			return false
		}
	}
	return true
}

func filterDisplayState(state displayState, owner string) displayState {
	all := state.Streams
	state.Streams = make([]displayStream, 0)
	ready := false
	for _, stream := range all {
		if stream.Owner != owner {
			state.Shared = true
			continue
		}
		stream.Owner = ""
		state.Streams = append(state.Streams, stream)
		ready = ready || (stream.Generation == state.Generation && stream.FirstFrame > 0)
	}
	if len(state.Streams) == 0 {
		state.Phase, state.Capture = "idle", nil
	} else if state.Phase == "active" && !ready {
		state.Phase = "starting"
	}
	return state
}

func withDisplays(next http.Handler, clients string, provider displayProvider, focusRead ...func(string) (json.RawMessage, error)) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		focus := r.URL.Path == "/v1/display-focus" && len(focusRead) == 1
		if r.URL.Path != "/v1/displays" && !focus {
			next.ServeHTTP(w, r)
			return
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", 403)
			return
		}
		if !focus && ((r.Method != "GET" && r.Method != "POST") || (r.URL.RawQuery != "" && (r.Method != "GET" || r.URL.RawQuery != "refresh=1"))) {
			http.NotFound(w, r)
			return
		}
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(20 * time.Second))
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "busy", 429)
			return
		}
		if focus {
			serveDisplayFocus(w, r, clients, provider, focusRead[0])
			return
		}
		var selection *displaySelection
		if r.Method == "POST" {
			selection = new(displaySelection)
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
			decoder.DisallowUnknownFields()
			if r.Header.Get("Content-Type") != "application/json" || decoder.Decode(selection) != nil || decoder.Decode(new(any)) != io.EOF || !displayInstance.MatchString(selection.Instance) || selection.Display == "" || len(selection.Display) > 256 || selection.Stream == 0 {
				http.Error(w, "invalid display request", 400)
				return
			}
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(digest[:])
		state, err := provider(r.Context(), r.URL.RawQuery != "", nil)
		status := http.StatusOK
		if err == nil && !validDisplayState(state) {
			err = errors.New("invalid engine display state")
		}
		if err == nil && selection != nil {
			owned := false
			for _, stream := range state.Streams {
				owned = owned || (stream.Owner == owner && stream.ID == selection.Stream)
			}
			if !owned || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
				http.Error(w, "no paired stream", 403)
				return
			}
			if state.Revision != selection.Revision || state.Instance != selection.Instance {
				state.Outcome, status = "stale", http.StatusConflict
			} else {
				state, err = provider(r.Context(), false, selection)
				if err == nil && !validDisplayState(state) {
					err = errors.New("invalid engine display state")
				}
				if err == nil && !state.Accepted {
					status = http.StatusConflict
				}
			}
		}
		if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", 403)
			return
		}
		if errors.Is(err, errDisplayUnsupported) {
			state = displayState{Protocol: 1, Error: "DISPLAY_UNSUPPORTED", Phase: "idle"}
		} else if err != nil {
			http.Error(w, "display control unavailable", 503)
			return
		} else {
			state.Supported = true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(filterDisplayState(state, owner))
	})
}
