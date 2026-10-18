package inputfocus

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const clipboardMessageLimit = 12 * 1024 * 1024
const clipboardTextLimit = 1024 * 1024

var clipboardRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)

type clipboardRequest struct {
	Op       string `json:"op"`
	ID       string `json:"id,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	Revision string `json:"revision,omitempty"`
	Expect   string `json:"expect,omitempty"`
}
type clipboardResponse struct {
	OK       bool   `json:"ok"`
	Code     string `json:"code,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	Revision string `json:"revision,omitempty"`
	Changed  *bool  `json:"changed,omitempty"`
}

func validClipboard(kind, text, data string) bool {
	switch kind {
	case "text":
		return data == "" && text != "" && len(text) <= clipboardTextLimit && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
	case "png":
		if text != "" || len(data) > base64.StdEncoding.EncodedLen(maxImageBytes) {
			return false
		}
		raw, err := base64.StdEncoding.Strict().DecodeString(data)
		if err != nil || len(raw) == 0 || len(raw) > maxImageBytes {
			return false
		}
		config, err := png.DecodeConfig(bytes.NewReader(raw))
		return err == nil && config.Width > 0 && config.Height > 0 && config.Width <= 4096 && config.Height <= 4096 && int64(config.Width)*int64(config.Height) <= 6000000
	}
	return false
}

// Explicit paired clipboard exchange. No background reads or unauthenticated fallback.
// The worker runs as the desktop user, and never returns paths or arbitrary formats.
func withClipboard(next http.Handler, clients string, read func(string) (json.RawMessage, error)) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/clipboard" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, result clipboardResponse) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(result)
		}
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			reply(403, clipboardResponse{Code: "CLIPBOARD_UNPAIRED"})
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			reply(415, clipboardResponse{Code: "CLIPBOARD_BAD_REQUEST"})
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			reply(429, clipboardResponse{Code: "CLIPBOARD_BUSY"})
			return
		}
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
		_ = controller.SetWriteDeadline(time.Now().Add(45 * time.Second))
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, clipboardMessageLimit))
		if err != nil {
			reply(413, clipboardResponse{Code: "CLIPBOARD_TOO_LARGE"})
			return
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var request clipboardRequest
		if !utf8.Valid(raw) || decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			reply(400, clipboardResponse{Code: "CLIPBOARD_BAD_REQUEST"})
			return
		}
		if (request.Op == "read" && (request.ID != "" || request.Kind != "" || request.Text != "" || request.Data != "" || request.Revision != "" || request.Expect != "")) ||
			(request.Op == "observe" && (request.ID != "" || request.Kind != "" || request.Text != "" || request.Data != "" || request.Expect != "" || (request.Revision != "" && !clipboardRevision.MatchString(request.Revision)))) ||
			(request.Op == "write" && (!fileID.MatchString(request.ID) || !validClipboard(request.Kind, request.Text, request.Data) || request.Revision != "" || (request.Expect != "" && !clipboardRevision.MatchString(request.Expect)))) ||
			(request.Op != "read" && request.Op != "write" && request.Op != "observe") {
			reply(400, clipboardResponse{Code: "CLIPBOARD_BAD_REQUEST"})
			return
		}
		if !allowed() {
			reply(403, clipboardResponse{Code: "CLIPBOARD_UNPAIRED"})
			return
		}
		owner := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		command, _ := json.Marshal(struct {
			clipboardRequest
			Owner string `json:"owner"`
		}{request, hex.EncodeToString(owner[:])})
		result, err := read("clipboard:" + string(command))
		if !allowed() {
			reply(403, clipboardResponse{Code: "CLIPBOARD_UNPAIRED"})
			return
		}
		var value clipboardResponse
		if err != nil || len(result) > clipboardMessageLimit || json.Unmarshal(result, &value) != nil {
			reply(503, clipboardResponse{Code: "CLIPBOARD_UNAVAILABLE"})
			return
		}
		if !value.OK {
			switch value.Code {
			case "CLIPBOARD_EMPTY", "CLIPBOARD_LOCKED", "CLIPBOARD_TOO_LARGE", "CLIPBOARD_ID_CONFLICT", "CLIPBOARD_PERMISSION_REQUIRED", "CLIPBOARD_CHANGED", "CLIPBOARD_SYNC_UNSUPPORTED":
				reply(409, clipboardResponse{Code: value.Code})
			default:
				reply(503, clipboardResponse{Code: "CLIPBOARD_UNAVAILABLE"})
			}
			return
		}
		if request.Op == "write" {
			reply(200, clipboardResponse{OK: true})
			return
		}
		if request.Op == "observe" {
			if !clipboardRevision.MatchString(value.Revision) || value.Changed == nil ||
				(!*value.Changed && (value.Revision != request.Revision || value.Kind != "" || value.Text != "" || value.Data != "")) ||
				(*value.Changed && (value.Revision == request.Revision || (value.Kind == "empty" && (value.Text != "" || value.Data != "")) || (value.Kind != "empty" && !validClipboard(value.Kind, value.Text, value.Data)))) {
				reply(503, clipboardResponse{Code: "CLIPBOARD_UNAVAILABLE"})
				return
			}
			reply(200, clipboardResponse{OK: true, Revision: value.Revision, Changed: value.Changed, Kind: value.Kind, Text: value.Text, Data: value.Data})
			return
		}
		if !validClipboard(value.Kind, value.Text, value.Data) {
			reply(503, clipboardResponse{Code: "CLIPBOARD_UNAVAILABLE"})
			return
		}
		reply(200, clipboardResponse{OK: true, Kind: value.Kind, Text: value.Text, Data: value.Data})
	})
}
