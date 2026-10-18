package inputfocus

import (
	"bytes"
	"cliprelay/network/hostprivacy"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type privacyBinding struct {
	Instance string `json:"instance"`
	Owner    string `json:"owner"`
	Stream   uint64 `json:"stream"`
	Lease    string `json:"lease"`
}

type privacyEngineRequest struct {
	Op string `json:"op"`
	privacyBinding
	Worker *hostprivacy.Identity `json:"worker,omitempty"`
}

type privacyEngineState struct {
	Protocol int `json:"protocol"`
	privacyBinding
	Supported  bool   `json:"supported"`
	Retained   bool   `json:"retained"`
	Authorized bool   `json:"authorized"`
	Ready      bool   `json:"ready"`
	Epoch      uint64 `json:"epoch"`
	Generation uint64 `json:"generation"`
	FirstFrame int64  `json:"firstFrame"`
	ExpiresMs  int64  `json:"expiresMs"`
	Outcome    string `json:"outcome"`
	Reason     string `json:"reason"`
}

type privacyEngineProvider func(context.Context, *privacyEngineRequest) (privacyEngineState, error)

func validPrivacyBinding(value privacyBinding) bool {
	return displayInstance.MatchString(value.Instance) && fileHash.MatchString(value.Owner) && fileID.MatchString(value.Lease) && value.Stream > 0 && value.Stream < 1<<53
}

func validPrivacyIdentity(value *hostprivacy.Identity) bool {
	if value == nil || value.PID <= 1 || value.PID > 1<<31-1 || value.BirthSec == 0 || value.BirthSec >= 1<<53 || value.BirthUsec >= 1000000 || len(value.Windows) == 0 || len(value.Windows) > 16 {
		return false
	}
	windows, displays := map[uint32]bool{}, map[uint32]bool{}
	for _, window := range value.Windows {
		if window.ID == 0 || window.Display == 0 || windows[window.ID] || displays[window.Display] {
			return false
		}
		windows[window.ID], displays[window.Display] = true, true
	}
	return true
}

// Reject duplicate keys at every level before decoding a bounded private
// message. No parser may reinterpret a second identity, lease or readiness flag.
func decodePrivacyJSON(raw []byte, target any, limit int) error {
	invalid := errors.New("invalid privacy protocol")
	if len(raw) == 0 || len(raw) > limit {
		return invalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 8 {
			return invalid
		}
		token, err := d.Token()
		if err != nil {
			return invalid
		}
		switch token {
		case json.Delim('{'):
			keys := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				name, ok := key.(string)
				// encoding/json also matches struct fields case-insensitively.
				// Treat those aliases as one key and reject non-ASCII names.
				for _, letter := range name {
					if letter > 127 {
						return invalid
					}
				}
				name = strings.ToLower(name)
				if err != nil || !ok || keys[name] {
					return invalid
				}
				keys[name] = true
				if walk(depth+1) != nil {
					return invalid
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return invalid
			}
		case json.Delim('['):
			if depth == 0 {
				return invalid
			}
			for d.More() {
				if walk(depth+1) != nil {
					return invalid
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return invalid
			}
		default:
			if depth == 0 {
				return invalid
			}
		}
		return nil
	}
	if walk(0) != nil {
		return invalid
	}
	if _, err := d.Token(); err != io.EOF {
		return invalid
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil || d.Decode(new(any)) != io.EOF {
		return invalid
	}
	return nil
}

func validPrivacyEngineState(state privacyEngineState) bool {
	if state.Protocol != 1 || !displayInstance.MatchString(state.Instance) || state.Epoch == 0 || state.Epoch >= 1<<53 || state.Generation >= 1<<53 || state.FirstFrame < 0 || state.ExpiresMs < 0 || state.ExpiresMs > 15000 {
		return false
	}
	switch state.Outcome {
	case "status", "accepted", "not_streaming", "worker_unavailable", "windows_unavailable", "busy", "invalid", "stale_instance", "stale", "expired", "not_ready", "renewed", "released", "worker_alive":
	default:
		return false
	}
	switch state.Reason {
	case "", "identity_unavailable", "expired", "stream_changed", "display_changed", "capture_changed", "restoring":
	default:
		return false
	}
	if !state.Retained {
		return !state.Authorized && !state.Ready && state.Owner == "" && state.Lease == "" && state.Stream == 0 && state.Generation == 0 && state.FirstFrame == 0 && state.ExpiresMs == 0
	}
	if !validPrivacyBinding(state.privacyBinding) || (state.Authorized && (!state.Supported || state.ExpiresMs == 0 || state.Reason != "")) || (!state.Authorized && state.ExpiresMs != 0) {
		return false
	}
	if state.Ready {
		return state.Authorized && state.Generation > 0 && state.FirstFrame > 0
	}
	return state.FirstFrame == 0
}

func enginePrivacyProviderWithAccess(access EngineAccess) privacyEngineProvider {
	return func(ctx context.Context, request *privacyEngineRequest) (privacyEngineState, error) {
		password, certificate, err := access()
		if err != nil {
			return privacyEngineState{}, err
		}
		return requestEnginePrivacy(ctx, "https://127.0.0.1:48790", password, certificate, request)
	}
}

func requestEnginePrivacy(ctx context.Context, endpoint, password string, certificate []byte, request *privacyEngineRequest) (privacyEngineState, error) {
	var payload []byte
	if request != nil {
		if !validPrivacyBinding(request.privacyBinding) {
			return privacyEngineState{}, errors.New("invalid privacy binding")
		}
		switch request.Op {
		case "prepare":
			if !validPrivacyIdentity(request.Worker) {
				return privacyEngineState{}, errors.New("invalid privacy identity")
			}
		case "status", "renew", "release":
			if request.Worker != nil {
				return privacyEngineState{}, errors.New("unexpected privacy identity")
			}
		default:
			return privacyEngineState{}, errors.New("invalid privacy operation")
		}
		payload, _ = json.Marshal(request)
	}
	raw, err := requestEngineJSON(ctx, endpoint, password, certificate, "/api/cliprelay/privacy", payload)
	if err != nil {
		return privacyEngineState{}, err
	}
	var state privacyEngineState
	if decodePrivacyJSON(raw, &state, 8192) != nil || !validPrivacyEngineState(state) {
		return privacyEngineState{}, errors.New("invalid engine privacy state")
	}
	return state, nil
}
