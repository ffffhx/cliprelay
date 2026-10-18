//go:build darwin || linux

// Package hostfiles implements the existing paired file protocol in an owned,
// unprivileged process. Authentication stays in the host's TLS front end.
package hostfiles

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const ChunkSize = 256 * 1024
const MessageLimit = 400 * 1024
const MaxFileSize int64 = 1 << 40
const reserveBytes uint64 = 32 * 1024 * 1024

var ownerPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var rootPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
var reservedName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)`)

type Request struct {
	Op     string `json:"op"`
	Owner  string `json:"owner"`
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

type Root struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Writable bool   `json:"writable"`
}
type Entry struct {
	Name      string `json:"name"`
	Directory bool   `json:"directory"`
	Size      int64  `json:"size"`
	Modified  int64  `json:"modified"`
	Blocked   bool   `json:"blocked"`
	Hidden    bool   `json:"hidden"`
}
type Response struct {
	OK        bool    `json:"ok"`
	Code      string  `json:"code,omitempty"`
	ID        string  `json:"id,omitempty"`
	Root      string  `json:"root,omitempty"`
	Path      string  `json:"path,omitempty"`
	Directory string  `json:"directory,omitempty"`
	Name      string  `json:"name,omitempty"`
	Direction string  `json:"direction,omitempty"`
	Size      int64   `json:"size"`
	Offset    int64   `json:"offset"`
	Verified  int64   `json:"verified"`
	State     string  `json:"state,omitempty"`
	SHA256    string  `json:"sha256,omitempty"`
	FinalName string  `json:"finalName,omitempty"`
	ChunkSize int     `json:"chunkSize,omitempty"`
	Next      string  `json:"next,omitempty"`
	Roots     []Root  `json:"roots,omitempty"`
	Entries   []Entry `json:"entries,omitempty"`
	Data      string  `json:"data,omitempty"`
}

type failure string

func (e failure) Error() string { return string(e) }
func fail(name string) error    { return failure("FILES_" + name) }
func errorCode(err error) string {
	var specific failure
	if errors.As(err, &specific) {
		return string(specific)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "FILES_NOT_FOUND"
	case errors.Is(err, fs.ErrExist):
		return "FILES_EXISTS"
	case errors.Is(err, fs.ErrPermission):
		return "FILES_ACCESS_DENIED"
	case errors.Is(err, unix.ELOOP):
		return "FILES_LINK_NOT_ALLOWED"
	case errors.Is(err, unix.ENOSPC), errors.Is(err, unix.EDQUOT):
		return "FILES_DISK_FULL"
	default:
		return "FILES_IO"
	}
}
func digest(data []byte) string { value := sha256.Sum256(data); return hex.EncodeToString(value[:]) }
func token() (string, error) {
	var value [16]byte
	_, err := rand.Read(value[:])
	return hex.EncodeToString(value[:]), err
}
func safeName(name string) bool {
	if !utf8.ValidString(name) || name == "" || len(utf16.Encode([]rune(name))) > 200 || strings.TrimSpace(name) != name ||
		name == "." || name == ".." || strings.HasSuffix(name, ".") || strings.HasPrefix(strings.ToLower(name), ".cliprelay-") || reservedName.MatchString(name) {
		return false
	}
	for _, r := range name {
		if r < 32 || strings.ContainsRune(`\/:*?"<>|`, r) {
			return false
		}
	}
	return true
}
func safePath(path string) bool {
	if len(path) > 4000 || len(utf16.Encode([]rune(path))) > 1000 {
		return false
	}
	if path == "" {
		return true
	}
	for _, part := range strings.Split(path, "/") {
		if !safeName(part) {
			return false
		}
	}
	return true
}

type fileKey struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

func identity(stat *unix.Stat_t) fileKey { return fileKey{uint64(stat.Dev), uint64(stat.Ino)} }

type fingerprint struct {
	Key      fileKey `json:"key"`
	Size     int64   `json:"size"`
	Modified int64   `json:"modified"`
	Changed  int64   `json:"changed"`
}

func stamp(stat *unix.Stat_t) fingerprint {
	return fingerprint{identity(stat), stat.Size, stat.Mtim.Nano(), stat.Ctim.Nano()}
}

type record struct {
	Owner     string      `json:"owner"`
	ID        string      `json:"id"`
	Root      string      `json:"root"`
	Directory string      `json:"directory"`
	Name      string      `json:"name"`
	Direction string      `json:"direction"`
	Size      int64       `json:"size"`
	SHA256    string      `json:"sha256"`
	Offset    int64       `json:"offset"`
	State     string      `json:"state"`
	FinalName string      `json:"finalName"`
	Verified  int64       `json:"verified"`
	Code      string      `json:"code"`
	Updated   int64       `json:"updated"`
	Folder    fileKey     `json:"folder"`
	Part      fileKey     `json:"part"`
	Source    fingerprint `json:"source"`
}

func (r *record) key() string { return r.Owner + "-" + r.ID }
func (r *record) snapshot() Response {
	return Response{OK: true, ID: r.ID, Root: r.Root, Directory: r.Directory, Name: r.Name, Direction: r.Direction, Size: r.Size,
		SHA256: r.SHA256, Offset: r.Offset, State: r.State, FinalName: r.FinalName, Verified: r.Verified, Code: r.Code, ChunkSize: ChunkSize}
}
