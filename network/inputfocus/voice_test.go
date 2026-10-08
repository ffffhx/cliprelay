package inputfocus

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVoiceOwnershipSequencingAndRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert, other := []byte("phone"), []byte("other phone")
	write := func(enabled bool) {
		t.Helper()
		var devices []any
		for _, raw := range [][]byte{cert, other} {
			devices = append(devices, map[string]any{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})), "enabled": enabled})
		}
		body, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": devices}})
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(true)
	var commands []string
	h := handler(path, func(command string) (json.RawMessage, error) {
		commands = append(commands, command)
		return json.RawMessage(`{"ok":true,"private":"not exposed"}`), nil
	})
	id, second := strings.Repeat("a", 32), strings.Repeat("b", 32)
	request := func(raw []byte, method, route, session, sequence, contentType string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/v1/voice/"+route, bytes.NewReader(body))
		if raw != nil {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: raw}}}
		}
		r.Header.Set("X-ClipRelay-Voice-Session", session)
		r.Header.Set("X-ClipRelay-Voice-Sequence", sequence)
		r.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, route := range []string{"status", "start", "audio", "stop", "cancel"} {
		if request(nil, "POST", route, id, "0", "", nil).Code != 403 {
			t.Fatal("unpaired", route)
		}
	}
	if len(commands) != 0 {
		t.Fatal("unpaired client reached helper")
	}
	status := request(cert, "GET", "status", "", "", "", nil)
	if status.Code != 200 || strings.Contains(status.Body.String(), "private") {
		t.Fatal(status.Body)
	}
	if request(cert, "POST", "start", id, "0", "", nil).Code != 200 {
		t.Fatal("start failed")
	}
	n := len(commands)
	for _, attempt := range []struct {
		peer       []byte
		action, id string
	}{
		{other, "start", second}, {other, "audio", id}, {other, "stop", id}, {other, "cancel", id}, {cert, "start", id},
	} {
		data := []byte(nil)
		typ := ""
		if attempt.action == "audio" {
			data = []byte{0, 0}
			typ = "application/octet-stream"
		}
		if request(attempt.peer, "POST", attempt.action, attempt.id, "0", typ, data).Code != 409 {
			t.Fatal("ownership", attempt.action)
		}
	}
	for _, bad := range []struct {
		sequence, contentType string
		pcm                   []byte
	}{
		{"1", "application/octet-stream", []byte{0, 0}}, {"0", "text/plain", []byte{0, 0}},
		{"0", "application/octet-stream", []byte{0}}, {"0", "application/octet-stream", make([]byte, 16002)},
	} {
		if request(cert, "POST", "audio", id, bad.sequence, bad.contentType, bad.pcm).Code < 400 {
			t.Fatal("bad audio accepted")
		}
	}
	if len(commands) != n {
		t.Fatal("invalid request reached helper", commands)
	}
	if request(cert, "POST", "audio", id, "0", "application/octet-stream", []byte{1, 2, 3, 4}).Code != 200 {
		t.Fatal("audio failed")
	}
	if commands[len(commands)-1] != "voice-audio:AQIDBA==" {
		t.Fatal(commands)
	}
	if request(cert, "POST", "audio", id, "0", "application/octet-stream", []byte{1, 2}).Code != 409 {
		t.Fatal("replayed audio")
	}
	write(false)
	if request(cert, "POST", "audio", id, "1", "application/octet-stream", []byte{1, 2}).Code != 403 {
		t.Fatal("revoked audio")
	}
	write(true)
	if request(cert, "POST", "stop", id, "1", "", nil).Code != 200 {
		t.Fatal("stop failed")
	}
	n = len(commands)
	if request(cert, "POST", "stop", id, "1", "", nil).Code != 409 || len(commands) != n {
		t.Fatal("stop replay reached helper")
	}
	if request(cert, "POST", "start", id, "0", "", nil).Code != 409 {
		t.Fatal("old session restarted")
	}
}

func TestVoiceExpiredSessionIsEndedBeforeReuse(t *testing.T) {
	now := time.Now()
	commands := []string{}
	v := &voiceHandler{now: func() time.Time { return now }, session: "old", owner: "old", last: now.Add(-7 * time.Second), started: now.Add(-7 * time.Second),
		read: func(command string) (json.RawMessage, error) {
			commands = append(commands, command)
			return json.RawMessage(`{"ok":true}`), nil
		}}
	// Exercise expiration via an authenticated request, as the outer handler does.
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("phone")
	b, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": []any{map[string]any{
		"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), "enabled": true}}}})
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/v1/voice/status", nil)
	r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
	w := httptest.NewRecorder()
	v.serve(w, r, path)
	if w.Code != 200 || v.session != "" || strings.Join(commands, ",") != "voice-cancel,voice-status" {
		t.Fatal(w.Code, commands)
	}
}
