package hostterminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

func Decode(raw []byte) (Request, error) {
	var request Request
	bad := errors.New("TERMINAL_BAD_REQUEST")
	if len(raw) > RequestLimit {
		return request, bad
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return request, bad
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return request, bad
		}
		if _, exists := fields[key]; exists {
			return request, bad
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(value, []byte("null")) {
			return request, bad
		}
		fields[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF {
		return request, bad
	}
	if json.Unmarshal(raw, &request) != nil {
		return request, bad
	}
	allowed := ""
	switch request.Op {
	case "sync":
		allowed = "op,owners"
	case "list":
		allowed = "op,owner"
	case "open":
		allowed = "op,owner,instance,id,shell,columns,rows,sequence"
	case "read":
		allowed = "op,owner,instance,id,offset"
	case "write", "paste":
		allowed = "op,owner,instance,id,sequence,data"
	case "resize":
		allowed = "op,owner,instance,id,columns,rows"
	case "close":
		allowed = "op,owner,instance,id"
	default:
		return request, bad
	}
	expected := strings.Split(allowed, ",")
	if len(fields) != len(expected) {
		return request, bad
	}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return request, bad
		}
	}
	if request.Op == "sync" {
		if request.Owners == nil || len(request.Owners) > 256 {
			return request, bad
		}
		seen := make(map[string]bool)
		for _, owner := range request.Owners {
			if !validHex(owner, 64) || seen[owner] {
				return request, bad
			}
			seen[owner] = true
		}
		return request, nil
	}
	if !validHex(request.Owner, 64) {
		return request, bad
	}
	if request.Op == "list" {
		return request, nil
	}
	if !validHex(request.Instance, 32) || !validHex(request.ID, 32) {
		return request, bad
	}
	if request.Op == "open" || request.Op == "resize" {
		if !dimensions(request.Columns, request.Rows) {
			return request, bad
		}
	}
	if request.Op == "open" && !shellAllowed(request.Shell) {
		return request, bad
	}
	if request.Op == "open" || request.Op == "write" || request.Op == "paste" {
		if request.Sequence <= 0 || request.Sequence > MaxSequence {
			return request, bad
		}
	}
	if request.Op == "read" && (request.Offset < 0 || request.Offset > MaxSequence) {
		return request, bad
	}
	return request, nil
}
