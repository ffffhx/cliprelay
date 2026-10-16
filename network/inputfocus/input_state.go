package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type inputStream struct {
	Owner        string `json:"owner,omitempty"`
	ID           uint64 `json:"id"`
	Epoch        uint32 `json:"epoch"`
	Acknowledged uint32 `json:"acknowledged"`
	Enabled      bool   `json:"enabled"`
	Paused       bool   `json:"paused"`
	Pending      bool   `json:"pending"`
	Closed       bool   `json:"closed"`
	Failed       bool   `json:"failed"`
	Exclusive    bool   `json:"exclusive"`
}
type inputState struct {
	Protocol  int           `json:"protocol"`
	Instance  string        `json:"instance"`
	Supported bool          `json:"supported"`
	Streams   []inputStream `json:"streams"`
}
type inputProvider func(context.Context) (inputState, error)

func engineInputProvider(dir string) inputProvider {
	return engineInputProviderWithAccess(fileEngineAccess(dir))
}

func engineInputProviderWithAccess(access EngineAccess) inputProvider {
	return func(ctx context.Context) (inputState, error) {
		password, certificate, err := access()
		if err != nil {
			return inputState{}, err
		}
		return requestEngineInput(ctx, "https://127.0.0.1:48790", password, certificate)
	}
}
func requestEngineInput(ctx context.Context, endpoint, password string, certificate []byte) (inputState, error) {
	body, err := requestEngineJSON(ctx, endpoint, password, certificate, "/api/cliprelay/input", nil)
	if err != nil {
		return inputState{}, err
	}
	var state inputState
	if json.Unmarshal(body, &state) != nil || !validInputState(state) {
		return inputState{}, errors.New("invalid engine input state")
	}
	state.Supported = true
	return state, nil
}
func validInputState(state inputState) bool {
	if state.Protocol != 1 || !displayInstance.MatchString(state.Instance) || len(state.Streams) > 64 {
		return false
	}
	seen := make(map[uint64]bool)
	for _, s := range state.Streams {
		if s.ID == 0 || s.ID > 1<<53-1 || seen[s.ID] || !fileHash.MatchString(s.Owner) || s.Exclusive != (len(state.Streams) == 1) {
			return false
		}
		seen[s.ID] = true
		if !s.Enabled {
			if s.Epoch != 0 || s.Acknowledged != 0 || s.Paused || s.Pending || s.Failed {
				return false
			}
			continue
		}
		if s.Epoch == 0 || s.Acknowledged > s.Epoch || s.Paused != (s.Epoch%2 == 1) || (s.Pending && (s.Closed || s.Failed)) {
			return false
		}
		if s.Pending || s.Failed {
			if s.Acknowledged != s.Epoch-1 {
				return false
			}
		} else if !s.Closed && s.Acknowledged != s.Epoch {
			return false
		}
	}
	return true
}

// Read-only: pause/resume commands travel over the authenticated native input
// transport. An HTTP client cannot claim that the viewer drained its input.
func withInputState(next http.Handler, clients string, provider inputProvider) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/input-state" {
			next.ServeHTTP(w, r)
			return
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", 403)
			return
		}
		if r.Method != "GET" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(12 * time.Second))
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "busy", 429)
			return
		}
		state, err := provider(r.Context())
		if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", 403)
			return
		}
		if errors.Is(err, errDisplayUnsupported) {
			state = inputState{Protocol: 1}
		} else if err != nil || !validInputState(state) {
			http.Error(w, "input state unavailable", 503)
			return
		} else {
			state.Supported = true
		}
		hash := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(hash[:])
		all := state.Streams
		state.Streams = make([]inputStream, 0)
		for _, stream := range all {
			if stream.Owner == owner {
				stream.Owner = ""
				state.Streams = append(state.Streams, stream)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(state)
	})
}
