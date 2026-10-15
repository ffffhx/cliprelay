package inputfocus

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"time"
)

const fileChunkSize = 256 * 1024
const fileMessageLimit = 400 * 1024

type fileRequest struct {
	Op     string `json:"op"`
	ID     string `json:"id,omitempty"`
	Root   string `json:"root,omitempty"`
	Path   string `json:"path,omitempty"`
	Name   string `json:"name,omitempty"`
	After  string `json:"after,omitempty"`
	Size   *int64 `json:"size,omitempty"`
	Offset *int64 `json:"offset,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Data   string `json:"data,omitempty"`
}

type fileRoot struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Writable bool   `json:"writable"`
}
type fileEntry struct {
	Name      string `json:"name"`
	Directory bool   `json:"directory"`
	Size      int64  `json:"size"`
	Modified  int64  `json:"modified"`
	Blocked   bool   `json:"blocked"`
	Hidden    bool   `json:"hidden"`
}
type fileResponse struct {
	OK        bool        `json:"ok"`
	Code      string      `json:"code,omitempty"`
	ID        string      `json:"id,omitempty"`
	Root      string      `json:"root,omitempty"`
	Path      string      `json:"path,omitempty"`
	Directory string      `json:"directory,omitempty"`
	Name      string      `json:"name,omitempty"`
	Direction string      `json:"direction,omitempty"`
	Size      int64       `json:"size"`
	Offset    int64       `json:"offset"`
	Verified  int64       `json:"verified"`
	State     string      `json:"state,omitempty"`
	SHA256    string      `json:"sha256,omitempty"`
	FinalName string      `json:"finalName,omitempty"`
	ChunkSize int         `json:"chunkSize,omitempty"`
	Next      string      `json:"next,omitempty"`
	Roots     []fileRoot  `json:"roots,omitempty"`
	Entries   []fileEntry `json:"entries,omitempty"`
	Data      string      `json:"data,omitempty"`
}

var fileID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var fileHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

type fileHandler struct {
	read func(string) (json.RawMessage, error)
	busy chan struct{}
}

func fileReply(w http.ResponseWriter, status int, result fileResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}

// All file I/O is delegated to the desktop user's process. The SYSTEM helper
// only authenticates, bounds requests and binds each journal to a certificate.
func (f *fileHandler) serve(w http.ResponseWriter, r *http.Request, clients string) {
	if r.Method != "POST" || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(45 * time.Second))
	select {
	case f.busy <- struct{}{}:
		defer func() { <-f.busy }()
	default:
		fileReply(w, 429, fileResponse{Code: "FILES_BUSY"})
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		fileReply(w, 415, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, fileMessageLimit))
	decoder.DisallowUnknownFields()
	var request fileRequest
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	if len(request.Root) > 32 || len(request.Path) > 4000 || len(request.Name) > 800 || len(request.After) > 1024 ||
		(request.Offset != nil && (*request.Offset < 0 || *request.Offset > 1<<40)) ||
		(request.Size != nil && (*request.Size < 0 || *request.Size > 1<<40)) {
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	switch request.Op {
	case "roots", "list", "mkdir":
	case "upload-start", "download-start", "status", "cancel", "upload-chunk", "download-chunk", "finish":
		if !fileID.MatchString(request.ID) {
			fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
			return
		}
	default:
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	if request.Op == "upload-chunk" {
		data, err := base64.StdEncoding.DecodeString(request.Data)
		digest := sha256.Sum256(data)
		if err != nil || len(data) == 0 || len(data) > fileChunkSize || request.Offset == nil || request.SHA256 != hex.EncodeToString(digest[:]) {
			fileReply(w, 400, fileResponse{Code: "FILES_HASH_MISMATCH"})
			return
		}
	} else if request.Data != "" {
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	if request.Op == "upload-start" && (request.Size == nil || !fileHash.MatchString(request.SHA256)) {
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	if request.Op == "download-chunk" && request.Offset == nil {
		fileReply(w, 400, fileResponse{Code: "FILES_BAD_REQUEST"})
		return
	}
	if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
		http.Error(w, "unpaired", 403)
		return
	}
	owner := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
	payload, _ := json.Marshal(struct {
		fileRequest
		Owner string `json:"owner"`
	}{request, hex.EncodeToString(owner[:])})
	data, err := f.read("files:" + string(payload))
	if err != nil {
		fileReply(w, 503, fileResponse{Code: "FILES_UNAVAILABLE"})
		return
	}
	// Revocation applies to reused connections and pending replies too.
	if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
		http.Error(w, "unpaired", 403)
		return
	}
	var result fileResponse
	if len(data) > fileMessageLimit || json.Unmarshal(data, &result) != nil {
		fileReply(w, 503, fileResponse{Code: "FILES_UNAVAILABLE"})
		return
	}
	if !result.OK {
		allowed := map[string]bool{
			"FILES_BAD_REQUEST": true, "FILES_BAD_PATH": true, "FILES_LINK_NOT_ALLOWED": true, "FILES_NOT_FOUND": true,
			"FILES_INVALID_STATE": true, "FILES_ACCESS_DENIED": true, "FILES_DISK_FULL": true, "FILES_IO": true,
			"FILES_NOT_READY": true, "FILES_OFFSET": true, "FILES_HASH_MISMATCH": true, "FILES_ID_CONFLICT": true,
			"FILES_QUEUE_FULL": true, "FILES_TOO_LARGE": true, "FILES_EXISTS": true, "FILES_CHUNK_CONFLICT": true,
			"FILES_SOURCE_CHANGED": true, "FILES_UNAVAILABLE": true,
		}
		if !allowed[result.Code] {
			result = fileResponse{Code: "FILES_UNAVAILABLE"}
		}
		fileReply(w, 409, fileResponse{Code: result.Code})
		return
	}
	if len(result.Roots) > 16 || len(result.Entries) > 256 || len(result.Data) > base64.StdEncoding.EncodedLen(fileChunkSize) {
		fileReply(w, 503, fileResponse{Code: "FILES_UNAVAILABLE"})
		return
	}
	fileReply(w, 200, result)
}
