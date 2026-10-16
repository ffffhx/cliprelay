// Package hostclipboard implements the application-owned Mac clipboard worker.
// Only explicit paired requests reach it; it never monitors or persists content.
package hostclipboard

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/png"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MessageLimit = 12 * 1024 * 1024
	TextLimit    = 1024 * 1024
	ImageLimit   = 8 * 1024 * 1024
)

var ownerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Payload struct {
	Kind string `json:"kind,omitempty"`
	Text string `json:"text,omitempty"`
	Data string `json:"data,omitempty"`
}

type Request struct {
	Op       string `json:"op"`
	Owner    string `json:"owner"`
	ID       string `json:"id,omitempty"`
	Revision string `json:"revision,omitempty"`
	Expect   string `json:"expect,omitempty"`
	Payload
}

type Response struct {
	OK       bool   `json:"ok"`
	Code     string `json:"code,omitempty"`
	Revision string `json:"revision,omitempty"`
	Changed  *bool  `json:"changed,omitempty"`
	Payload
}

// Access runs serially on the worker's owning thread. Available is checked both
// before and after reading, and again immediately before a native write.
type Access interface {
	Available() error
	Read() (Payload, error)
	Write(Payload) error
}

// VersionedAccess supports bounded observation without reading unchanged
// content, and a native last-moment version check before replacing the board.
type VersionedAccess interface {
	Access
	Version() (string, error)
	WriteIfVersion(Payload, string) (bool, error)
}

type Exchange struct {
	access   Access
	receipts map[string][32]byte
	order    []string
	epoch    [32]byte
}

func New(access Access) *Exchange {
	e := &Exchange{access: access, receipts: make(map[string][32]byte)}
	_, _ = rand.Read(e.epoch[:])
	return e
}

func (e *Exchange) revision(raw string) string {
	value := sha256.Sum256(append(e.epoch[:len(e.epoch):len(e.epoch)], []byte(raw)...))
	return hex.EncodeToString(value[:])
}

func failure(err error) Response {
	code := "CLIPBOARD_UNAVAILABLE"
	if err != nil {
		switch err.Error() {
		case "CLIPBOARD_EMPTY", "CLIPBOARD_LOCKED", "CLIPBOARD_TOO_LARGE", "CLIPBOARD_ID_CONFLICT", "CLIPBOARD_BAD_REQUEST", "CLIPBOARD_PERMISSION_REQUIRED", "CLIPBOARD_CHANGED", "CLIPBOARD_SYNC_UNSUPPORTED":
			code = err.Error()
		}
	}
	return Response{Code: code}
}

func validate(value Payload) error {
	switch value.Kind {
	case "text":
		if len(value.Text) > TextLimit {
			return errors.New("CLIPBOARD_TOO_LARGE")
		}
		if value.Text != "" && value.Data == "" && utf8.ValidString(value.Text) && !strings.ContainsRune(value.Text, 0) {
			return nil
		}
	case "png":
		if len(value.Data) > base64.StdEncoding.EncodedLen(ImageLimit) {
			return errors.New("CLIPBOARD_TOO_LARGE")
		}
		if value.Text != "" {
			break
		}
		raw, err := base64.StdEncoding.Strict().DecodeString(value.Data)
		if err != nil || len(raw) == 0 {
			break
		}
		if len(raw) > ImageLimit {
			return errors.New("CLIPBOARD_TOO_LARGE")
		}
		config, err := png.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			break
		}
		if config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 || int64(config.Width)*int64(config.Height) > 6000000 {
			return errors.New("CLIPBOARD_TOO_LARGE")
		}
		// A valid IHDR alone does not make a valid PNG. Decode within the pixel
		// budget before allowing the native clipboard to replace any content.
		if _, err := png.Decode(bytes.NewReader(raw)); err == nil {
			return nil
		}
	}
	return errors.New("CLIPBOARD_BAD_REQUEST")
}

func (e *Exchange) Handle(ctx context.Context, request Request) Response {
	bad := func() Response { return failure(errors.New("CLIPBOARD_BAD_REQUEST")) }
	if !ownerPattern.MatchString(request.Owner) {
		return bad()
	}
	switch request.Op {
	case "read":
		if request.ID != "" || request.Payload != (Payload{}) || request.Revision != "" || request.Expect != "" {
			return bad()
		}
	case "observe":
		if request.ID != "" || request.Payload != (Payload{}) || request.Expect != "" || (request.Revision != "" && !ownerPattern.MatchString(request.Revision)) {
			return bad()
		}
	case "write":
		if !idPattern.MatchString(request.ID) || request.Revision != "" || (request.Expect != "" && !ownerPattern.MatchString(request.Expect)) {
			return bad()
		}
		if err := validate(request.Payload); err != nil {
			return failure(err)
		}
	default:
		return bad()
	}
	if ctx.Err() != nil {
		return failure(ctx.Err())
	}
	if err := e.access.Available(); err != nil {
		return failure(err)
	}
	if request.Op == "observe" {
		return e.observe(ctx, request.Revision)
	}
	if request.Op == "read" {
		value, err := e.access.Read()
		if err != nil {
			return failure(err)
		}
		if ctx.Err() != nil {
			return failure(ctx.Err())
		}
		if err := e.access.Available(); err != nil {
			return failure(err)
		}
		if value == (Payload{}) {
			return failure(errors.New("CLIPBOARD_EMPTY"))
		}
		if err := validate(value); err != nil {
			return failure(err)
		}
		return Response{OK: true, Payload: value}
	}
	// Retain only bounded hashes, scoped to the authenticated certificate.
	// Lost replies cannot cause the same write to replace a newer clipboard.
	key := request.Owner + ":" + request.ID
	digest := sha256.Sum256([]byte(request.Kind + "\n" + request.Text + "\n" + request.Data + "\n" + request.Expect))
	if previous, ok := e.receipts[key]; ok {
		if previous != digest {
			return failure(errors.New("CLIPBOARD_ID_CONFLICT"))
		}
		return Response{OK: true}
	}
	if ctx.Err() != nil {
		return failure(ctx.Err())
	}
	if request.Expect != "" {
		access, ok := e.access.(VersionedAccess)
		if !ok {
			return failure(errors.New("CLIPBOARD_SYNC_UNSUPPORTED"))
		}
		version, err := access.Version()
		if err != nil {
			return failure(err)
		}
		if e.revision(version) != request.Expect {
			return failure(errors.New("CLIPBOARD_CHANGED"))
		}
		if ctx.Err() != nil {
			return failure(ctx.Err())
		}
		written, err := access.WriteIfVersion(request.Payload, version)
		if err != nil {
			return failure(err)
		}
		if !written {
			return failure(errors.New("CLIPBOARD_CHANGED"))
		}
	} else {
		if err := e.access.Write(request.Payload); err != nil {
			return failure(err)
		}
	}
	if len(e.order) == 256 {
		delete(e.receipts, e.order[0])
		e.order = e.order[1:]
	}
	e.order = append(e.order, key)
	e.receipts[key] = digest
	return Response{OK: true}
}

func (e *Exchange) observe(ctx context.Context, previous string) Response {
	access, ok := e.access.(VersionedAccess)
	if !ok {
		return failure(errors.New("CLIPBOARD_SYNC_UNSUPPORTED"))
	}
	version, err := access.Version()
	if err != nil {
		return failure(err)
	}
	revision := e.revision(version)
	changed := revision != previous
	if !changed {
		return Response{OK: true, Revision: revision, Changed: &changed}
	}
	value, err := access.Read()
	if err != nil && err.Error() != "CLIPBOARD_EMPTY" {
		return failure(err)
	}
	if ctx.Err() != nil {
		return failure(ctx.Err())
	}
	if err := access.Available(); err != nil {
		return failure(err)
	}
	current, err := access.Version()
	if err != nil {
		return failure(err)
	}
	if current != version {
		return failure(errors.New("CLIPBOARD_CHANGED"))
	}
	if value == (Payload{}) {
		value.Kind = "empty"
	} else if err := validate(value); err != nil {
		return failure(err)
	}
	return Response{OK: true, Revision: revision, Changed: &changed, Payload: value}
}

func decode(line []byte) (Request, error) {
	var request Request
	if !utf8.Valid(line) || !bytes.HasPrefix(line, []byte("clipboard:")) {
		return request, errors.New("CLIPBOARD_PROTOCOL_INVALID")
	}
	decoder := json.NewDecoder(bytes.NewReader(line[len("clipboard:"):]))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
		return request, errors.New("CLIPBOARD_PROTOCOL_INVALID")
	}
	return request, nil
}
