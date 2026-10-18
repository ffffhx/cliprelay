package inputfocus

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImageUploadBoundariesAndAuthorization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	db, _ := json.Marshal(map[string]any{"root": map[string]any{"named_devices": []any{map[string]any{
		"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), "enabled": true}}}})
	if err := os.WriteFile(path, db, 0600); err != nil {
		t.Fatal(err)
	}
	var payload bytes.Buffer
	png.Encode(&payload, image.NewNRGBA(image.Rect(0, 0, 32, 24)))
	reads := 0
	h := handler(path, func(command string) (json.RawMessage, error) {
		reads++
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(command, "image:"))
		if err != nil || !strings.HasPrefix(command, "image:") || !bytes.Equal(decoded, payload.Bytes()) {
			t.Fatal("Image was not delivered unchanged")
		}
		return json.RawMessage(`{"ok":true,"extra":"private"}`), nil
	})
	request := func(peer bool, body []byte, kind string, length int64) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/clipboard-image", bytes.NewReader(body))
		r.ContentLength = length
		r.Header.Set("Content-Type", kind)
		if peer {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if request(false, payload.Bytes(), "image/png", -1).Code != 403 {
		t.Fatal("unpaired upload accepted")
	}
	if request(true, payload.Bytes(), "text/plain", -1).Code != 415 {
		t.Fatal("content type not checked")
	}
	if request(true, []byte("not a PNG"), "image/png", -1).Code != 400 {
		t.Fatal("invalid image accepted")
	}
	if request(true, payload.Bytes(), "image/png", maxImageBytes+1).Code != 413 {
		t.Fatal("oversize accepted")
	}
	if request(true, make([]byte, maxImageBytes+1), "image/png", -1).Code != 413 {
		t.Fatal("chunked oversize accepted")
	}
	var huge bytes.Buffer
	png.Encode(&huge, image.NewNRGBA(image.Rect(0, 0, 5000, 1)))
	if request(true, huge.Bytes(), "image/png", -1).Code != 400 {
		t.Fatal("oversize dimensions accepted")
	}
	if reads != 0 {
		t.Fatal("invalid upload changed clipboard")
	}
	w := request(true, payload.Bytes(), "image/png", -1)
	var response map[string]any
	json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 200 || len(response) != 3 || response["ok"] != true || response["width"] != float64(32) {
		t.Fatal(w.Code, response)
	}
	if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if request(true, payload.Bytes(), "image/png", -1).Code != 403 || reads != 1 {
		t.Fatal("revoked client accepted")
	}
}

func TestImageUploadManagedClipboardIdentityAndPostReadRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, path, cert)
	var payload bytes.Buffer
	if err := png.Encode(&payload, image.NewNRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	revoked := false
	focus := func(string) (json.RawMessage, error) { t.Fatal("image reached focus worker"); return nil, nil }
	provider := func(command string) (json.RawMessage, error) {
		var value map[string]string
		if !strings.HasPrefix(command, "clipboard:") || json.Unmarshal([]byte(command[10:]), &value) != nil {
			t.Fatal(command)
		}
		if value["owner"] != displayOwner(cert) || !fileID.MatchString(value["id"]) || value["op"] != "write" || value["kind"] != "png" || value["data"] != base64.StdEncoding.EncodeToString(payload.Bytes()) {
			t.Fatal("image identity or payload changed")
		}
		if revoked {
			if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		return json.RawMessage(`{"ok":true}`), nil
	}
	h := handler(path, focus, focus, focus, provider)
	for _, code := range []int{200, 403} {
		revoked = code == 403
		r := httptest.NewRequest("POST", "/v1/clipboard-image", bytes.NewReader(payload.Bytes()))
		r.Header.Set("Content-Type", "image/png")
		r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: cert}}}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != code {
			t.Fatal(w.Code, w.Body)
		}
	}
}
