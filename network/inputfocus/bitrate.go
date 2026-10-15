package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

type bitrateStream struct {
	Owner        string `json:"owner,omitempty"`
	ID           uint64 `json:"id"`
	Revision     uint64 `json:"revision"`
	Supported    bool   `json:"supported"`
	Budget       int    `json:"budgetKbps"`
	Video        int    `json:"videoKbps"`
	RequestID    uint64 `json:"requestId"`
	Requested    int    `json:"requestedKbps"`
	Target       int    `json:"targetVideoKbps"`
	AppliedFrame int64  `json:"appliedFrame"`
	Result       string `json:"result"`
	Error        string `json:"error"`
}

type bitrateState struct {
	Protocol  int             `json:"protocol"`
	Instance  string          `json:"instance"`
	Supported bool            `json:"supported"`
	Streams   []bitrateStream `json:"streams"`
	Accepted  bool            `json:"accepted"`
	Outcome   string          `json:"outcome,omitempty"`
}

// Owner is always derived from the request's mutual-TLS certificate. It is not
// accepted in the public request body, including when the caller owns a stream.
type bitrateSelection struct {
	Instance string `json:"instance"`
	Stream   uint64 `json:"stream"`
	Revision uint64 `json:"revision"`
	Budget   int    `json:"budgetKbps"`
}
type bitrateProvider func(context.Context, string, *bitrateSelection) (bitrateState, error)

func engineBitrateProvider(dir string) bitrateProvider {
	return func(ctx context.Context, owner string, selection *bitrateSelection) (bitrateState, error) {
		password, certificate, err := readEngineAccess(dir)
		if err != nil {
			return bitrateState{}, err
		}
		return requestEngineBitrate(ctx, "https://127.0.0.1:48790", password, certificate, owner, selection)
	}
}

func requestEngineBitrate(ctx context.Context, endpoint, password string, certificate []byte, owner string, selection *bitrateSelection) (bitrateState, error) {
	var state bitrateState
	var payload []byte
	if selection != nil {
		if !fileHash.MatchString(owner) {
			return state, errors.New("missing bitrate owner")
		}
		payload, _ = json.Marshal(struct {
			bitrateSelection
			Owner string `json:"owner"`
		}{*selection, owner})
	}
	body, err := requestEngineJSON(ctx, endpoint, password, certificate, "/api/cliprelay/bitrate", payload)
	if err != nil {
		return state, err
	}
	if json.Unmarshal(body, &state) != nil || !validBitrateState(state) {
		return bitrateState{}, errors.New("invalid engine bitrate state")
	}
	state.Supported = true
	return state, nil
}

func validBitrateState(s bitrateState) bool {
	if s.Protocol != 1 || !displayInstance.MatchString(s.Instance) || len(s.Streams) > 64 || len(s.Outcome) > 32 {
		return false
	}
	seen := make(map[uint64]bool)
	for _, stream := range s.Streams {
		if !fileHash.MatchString(stream.Owner) || stream.ID == 0 || seen[stream.ID] || stream.Revision == 0 ||
			stream.AppliedFrame < 0 || stream.Video < 1 || stream.Video > 1000000 || len(stream.Error) > 64 {
			return false
		}
		seen[stream.ID] = true
		for _, value := range []int{stream.Budget, stream.Requested, stream.Target} {
			if value < 0 || value > 1000000 {
				return false
			}
		}
		switch stream.Result {
		case "", "pending", "failed":
		case "applied":
			if stream.AppliedFrame == 0 || stream.RequestID == 0 || stream.Budget != stream.Requested || stream.Video != stream.Target {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func withBitrate(next http.Handler, clients string, provider bitrateProvider) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/bitrate" {
			next.ServeHTTP(w, r)
			return
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", 403)
			return
		}
		if (r.Method != "GET" && r.Method != "POST") || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Second))
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "busy", 429)
			return
		}
		var selection *bitrateSelection
		if r.Method == "POST" {
			selection = new(bitrateSelection)
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
			decoder.DisallowUnknownFields()
			if r.Header.Get("Content-Type") != "application/json" || decoder.Decode(selection) != nil || decoder.Decode(new(any)) != io.EOF ||
				!displayInstance.MatchString(selection.Instance) || selection.Stream == 0 || selection.Revision == 0 || selection.Budget < 500 || selection.Budget > 150000 {
				http.Error(w, "invalid bitrate request", 400)
				return
			}
		}
		hash := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(hash[:])
		state, err := provider(r.Context(), owner, nil)
		status := http.StatusOK
		if err == nil && !validBitrateState(state) {
			err = errors.New("invalid engine bitrate state")
		}
		if err == nil && selection != nil {
			var current *bitrateStream
			for i := range state.Streams {
				if state.Streams[i].Owner == owner && state.Streams[i].ID == selection.Stream {
					current = &state.Streams[i]
					break
				}
			}
			if current == nil || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
				http.Error(w, "no paired stream", 403)
				return
			}
			if state.Instance != selection.Instance || current.Revision != selection.Revision {
				state.Outcome, status = "stale", http.StatusConflict
			} else {
				// The engine repeats stream/owner/revision checks under its mutex;
				// a disconnect or reuse between this read and POST cannot retarget it.
				state, err = provider(r.Context(), owner, selection)
				if err == nil && !validBitrateState(state) {
					err = errors.New("invalid engine bitrate state")
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
			state = bitrateState{Protocol: 1, Outcome: "BITRATE_UNSUPPORTED"}
		} else if err != nil {
			http.Error(w, "bitrate control unavailable", 503)
			return
		} else {
			state.Supported = true
		}
		all := state.Streams
		state.Streams = make([]bitrateStream, 0)
		for _, stream := range all {
			if stream.Owner == owner {
				stream.Owner = ""
				state.Streams = append(state.Streams, stream)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(state)
	})
}
