package inputfocus

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestFocusAuthorizationAndRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("test paired certificate")
	write := func(enabled any, data []byte) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": []any{map[string]any{
			"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: data})), "enabled": enabled}}}})
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	reads := 0
	h := handler(path, func(command string) (json.RawMessage, error) {
		reads++
		if command == "app" {
			return json.RawMessage(`{"supported":true,"appId":"orca","title":"private"}`), nil
		}
		return json.RawMessage(`{"supported":true,"editable":true,"focusId":"opaque"}`), nil
	})
	request := func(certificate []byte, method, url string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, nil)
		if certificate != nil {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: certificate}}}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	write("true", cert)
	for _, peer := range [][]byte{nil, []byte("another phone")} {
		if w := request(peer, "GET", "/v1/input-focus"); w.Code != http.StatusForbidden {
			t.Fatal(w.Code)
		}
	}
	if reads != 0 {
		t.Fatal("unpaired client read focus")
	}
	w := request(cert, "GET", "/v1/input-focus")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body)
	}
	var value map[string]any
	json.Unmarshal(w.Body.Bytes(), &value)
	if len(value) != 3 || value["editable"] != true || value["focusId"] != "opaque" {
		t.Fatal(value)
	}
	for _, enabled := range []any{"false", false, "0"} {
		write(enabled, cert)
		if w := request(cert, "GET", "/v1/input-focus"); w.Code != http.StatusForbidden {
			t.Fatal("disabled client accepted")
		}
	}
	write(true, []byte("replacement phone"))
	if w := request(cert, "GET", "/v1/input-focus"); w.Code != http.StatusForbidden {
		t.Fatal("revoked client accepted")
	}
	write(true, cert)
	if request(cert, "POST", "/v1/input-focus").Code != 404 || request(cert, "GET", "/api/pin").Code != 404 {
		t.Fatal("unexpected operation exposed")
	}
	app := request(cert, "GET", "/v1/foreground-app")
	var application map[string]any
	json.Unmarshal(app.Body.Bytes(), &application)
	if app.Code != 200 || len(application) != 2 || application["appId"] != "orca" {
		t.Fatal(application)
	}
	if request(nil, "GET", "/v1/foreground-app").Code != 403 {
		t.Fatal("unpaired app read")
	}
	if reads != 2 {
		t.Fatal("unauthorized route reached focus provider")
	}
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if request(cert, "GET", "/v1/input-focus").Code != 403 {
		t.Fatal("invalid pairing state must fail closed")
	}
}

func TestTapTargetValidationAndCompatibility(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired phone")
	data, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": []any{map[string]any{
		"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), "enabled": true}}}})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	var commands []string
	reply := `{"supported":true,"editable":false,"focusId":"","targeted":true,"text":"private"}`
	h := handler(path, func(command string) (json.RawMessage, error) {
		commands = append(commands, command)
		return json.RawMessage(reply), nil
	})
	request := func(query string, paired bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v1/input-focus"+query, nil)
		if paired {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if request("?x=0.1&y=0.8", false).Code != 403 {
		t.Fatal("unpaired hit test accepted")
	}
	for _, query := range []string{"?x=0.1", "?x=0.1&y=", "?x=NaN&y=0.1", "?x=0.1&y=Inf",
		"?x=-0.1&y=0.1", "?x=0.1&y=1.1", "?x=0.1&x=0.9&y=0.1", "?x=0.1&y=0.2&text=private",
		"?x=%0Aapp&y=0.1", "?x=%zz&y=0.1"} {
		if w := request(query, true); w.Code != 400 {
			t.Fatalf("%s: %d", query, w.Code)
		}
	}
	if len(commands) != 0 {
		t.Fatal("invalid or unauthorized tap reached provider", commands)
	}
	w := request("?x=0.1&y=0.8", true)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || len(commands) != 1 || commands[0] != "focus:0.1:0.8" || len(result) != 4 ||
		result["targeted"] != true || result["editable"] != false {
		t.Fatal(w.Code, commands, result)
	}
	// A helper that has not been upgraded must not advertise point verification.
	reply = `{"supported":true,"editable":true,"focusId":"sticky-editor"}`
	w = request("?x=0&y=1", true)
	result = nil
	json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || len(result) != 3 || result["targeted"] != nil || commands[1] != "focus:0:1" {
		t.Fatal(w.Code, commands, result)
	}
}
