package inputfocus

// Application-owned hosting approves the live in-memory request over its
// private local socket. Legacy Windows approval files retain their old route;
// a managed host never adopts a file left by an earlier process or request.
import (
	"bytes"
	"encoding/json"
	"io"
	"sort"
	"strings"
	"time"
)

type managedPairRequest struct {
	ID           string `json:"id"`
	Generation   string `json:"generation"`
	Name         string `json:"name"`
	Verification string `json:"verification"`
	Expires      int64  `json:"expires"`
	State        string `json:"state"`
}

func managedPairError(code string) map[string]any {
	return map[string]any{"protocol": 1, "ok": false, "code": code}
}

func managedPairFields(raw []byte) (map[string]string, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	fields := make(map[string]string)
	for d.More() {
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok || (key != "op" && key != "id" && key != "generation" && key != "verification") {
			return nil, false
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, false
		}
		var value string
		if d.Decode(&value) != nil {
			return nil, false
		}
		fields[key] = value
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') || d.Decode(new(any)) != io.EOF {
		return nil, false
	}
	return fields, true
}

func (p *lanPairer) local(raw []byte) (any, bool) {
	if !p.managed {
		return nil, false
	}
	var selector struct {
		Op string `json:"op"`
	}
	if json.Unmarshal(raw, &selector) != nil || !strings.HasPrefix(selector.Op, "host-pair-") {
		return nil, false
	}
	fields, valid := managedPairFields(raw)
	if len(raw) > 2048 || !valid {
		return managedPairError("HOST_PAIR_INVALID"), true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.ctx.Err() != nil {
		return managedPairError("HOST_PAIR_CLOSED"), true
	}
	now := time.Now().Unix()
	if fields["op"] == "host-pair-list" && len(fields) == 1 {
		requests := []managedPairRequest{}
		for _, request := range p.requests {
			if request.Expires > now && request.decision != "rejected" {
				requests = append(requests, managedPairRequest{request.ID, request.generation, request.Name, request.Verification, request.Expires, request.decision})
			}
		}
		sort.Slice(requests, func(i, j int) bool { return requests[i].ID < requests[j].ID })
		return map[string]any{"protocol": 1, "ok": true, "requests": requests}, true
	}
	if (fields["op"] != "host-pair-approve" && fields["op"] != "host-pair-reject") || len(fields) != 4 ||
		!pairNonce.MatchString(fields["id"]) || !pairNonce.MatchString(fields["generation"]) {
		return managedPairError("HOST_PAIR_INVALID"), true
	}
	request := p.requests[fields["id"]]
	if request == nil || request.Expires <= now || request.generation != fields["generation"] ||
		request.Verification != fields["verification"] || request.decision != "waiting" {
		return managedPairError("HOST_PAIR_STALE"), true
	}
	approved := fields["op"] == "host-pair-approve"
	request.decision = "approving"
	if !approved {
		request.decision = "rejected"
		request.finalState = "rejected"
		request.cancel()
	}
	request.approval <- approved
	return map[string]any{"protocol": 1, "ok": true}, true
}
