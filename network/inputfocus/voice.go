package inputfocus

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type voiceResult struct {
	OK   bool   `json:"ok"`
	Code string `json:"code"`
}

// One bounded dictation at a time, owned by the paired certificate AND an unpredictable
// client-generated session. No retries/replayed audio and no audio stored on disk.
type voiceHandler struct {
	mu                       sync.Mutex
	read                     func(string) (json.RawMessage, error)
	now                      func() time.Time
	session, owner, previous string
	sequence, bytes          int
	started, last            time.Time
}

func voiceReply(w http.ResponseWriter, status int, result voiceResult) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}

func (v *voiceHandler) call(command string) voiceResult {
	data, err := v.read(command)
	var result voiceResult
	if err != nil || json.Unmarshal(data, &result) != nil {
		return voiceResult{Code: "VOICE_UNAVAILABLE"}
	}
	// Only fixed machine codes leave the helper, never provider messages or paths.
	switch result.Code {
	case "", "DOUBAO_REQUIRED", "DOUBAO_VERSION_UNSUPPORTED",
		"VIRTUAL_MIC_REQUIRED", "VOICE_AUDIO_DEVICE_FAILED", "VOICE_AUDIO_BACKLOG",
		"VOICE_BUSY", "VOICE_FOCUS_REQUIRED", "VOICE_ENDED",
		"VOICE_INPUT_FAILED", "VOICE_UNAVAILABLE", "VOICE_INVALID_AUDIO":
	default:
		return voiceResult{Code: "VOICE_UNAVAILABLE"}
	}
	return result
}

func (v *voiceHandler) clear() {
	v.previous = v.session
	v.session, v.owner = "", ""
	v.sequence, v.bytes = 0, 0
}

func (v *voiceHandler) serve(w http.ResponseWriter, r *http.Request, clients string) {
	route := strings.TrimPrefix(r.URL.Path, "/v1/voice/")
	if r.URL.RawQuery != "" || (route == "status" && r.Method != "GET") ||
		(route != "status" && (r.Method != "POST" || (route != "start" && route != "audio" && route != "stop" && route != "cancel"))) {
		http.NotFound(w, r)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	var audio []byte
	if route == "audio" {
		if r.Header.Get("Content-Type") != "application/octet-stream" {
			voiceReply(w, 415, voiceResult{Code: "VOICE_INVALID_AUDIO"})
			return
		}
		var err error
		audio, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 16000))
		if err != nil || len(audio) == 0 || len(audio)%2 != 0 {
			voiceReply(w, 400, voiceResult{Code: "VOICE_INVALID_AUDIO"})
			return
		}
	} else if r.ContentLength != 0 {
		voiceReply(w, 400, voiceResult{Code: "VOICE_INVALID_REQUEST"})
		return
	}
	if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
		http.Error(w, "unpaired", 403)
		return
	}
	if !v.mu.TryLock() {
		voiceReply(w, 429, voiceResult{Code: "VOICE_BUSY"})
		return
	}
	defer v.mu.Unlock()
	if v.session != "" && (v.now().Sub(v.last) > 6*time.Second || v.now().Sub(v.started) > 180*time.Second) {
		v.call("voice-cancel")
		v.clear()
	}
	if route == "status" {
		if v.session != "" {
			voiceReply(w, 409, voiceResult{Code: "VOICE_BUSY"})
			return
		}
		result := v.call("voice-status")
		voiceReply(w, 200, result)
		return
	}
	session := r.Header.Get("X-ClipRelay-Voice-Session")
	decoded, err := hex.DecodeString(session)
	if err != nil || len(decoded) != 16 || len(session) != 32 {
		voiceReply(w, 400, voiceResult{Code: "VOICE_INVALID_SESSION"})
		return
	}
	owner := string(r.TLS.PeerCertificates[0].Raw)
	if route == "start" {
		if v.session != "" || session == v.previous {
			voiceReply(w, 409, voiceResult{Code: "VOICE_BUSY"})
			return
		}
		result := v.call("voice-start")
		if result.OK {
			v.session, v.owner = session, owner
			v.started, v.last = v.now(), v.now()
		}
		voiceReply(w, 200, result)
		return
	}
	if v.session != session || v.owner != owner {
		voiceReply(w, 409, voiceResult{Code: "VOICE_ENDED"})
		return
	}
	if route == "audio" {
		sequence, err := strconv.Atoi(r.Header.Get("X-ClipRelay-Voice-Sequence"))
		if err != nil || sequence != v.sequence {
			voiceReply(w, 409, voiceResult{Code: "VOICE_SEQUENCE"})
			return
		}
		if v.bytes+len(audio) > 32000*180 {
			v.call("voice-cancel")
			v.clear()
			voiceReply(w, 413, voiceResult{Code: "VOICE_LIMIT"})
			return
		}
		result := v.call("voice-audio:" + base64.StdEncoding.EncodeToString(audio))
		if result.OK {
			v.sequence++
			v.bytes += len(audio)
			v.last = v.now()
		} else {
			v.call("voice-cancel")
			v.clear()
		}
		voiceReply(w, 200, result)
		return
	}
	result := v.call("voice-" + route)
	v.clear()
	voiceReply(w, 200, result)
}
