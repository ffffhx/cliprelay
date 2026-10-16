package inputfocus

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestEngineAccessMemoryValidationAndIndependentPins(t *testing.T) {
	var empty MemoryEngineAccess
	if _, _, err := empty.Read(); !errors.Is(err, errEngineAccessUnavailable) {
		t.Fatal("zero-value owner returned a credential")
	}
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	password := strings.Repeat("fixture", 4)
	for _, value := range []struct {
		password string
		cert     []byte
	}{
		{"short", server.Certificate().Raw}, {strings.Repeat("x", 1025), server.Certificate().Raw},
		{password, nil}, {password, []byte("invalid certificate")}, {password, make([]byte, 65537)},
	} {
		if access, err := NewMemoryEngineAccess(value.password, value.cert); access != nil || !errors.Is(err, errEngineAccessUnavailable) {
			t.Fatal("invalid credential accepted")
		}
	}
	certificate := append([]byte(nil), server.Certificate().Raw...)
	access, err := NewMemoryEngineAccess(password, certificate)
	if err != nil {
		t.Fatal(err)
	}
	defer access.Close()
	certificate[0] ^= 1
	got, first, err := access.Read()
	if err != nil || got != password || !bytes.Equal(first, server.Certificate().Raw) {
		t.Fatal("caller mutated retained pin")
	}
	first[0] ^= 1
	_, second, err := access.Read()
	if err != nil || !bytes.Equal(second, server.Certificate().Raw) {
		t.Fatal("request mutated retained pin")
	}
}

func TestEngineAccessMemoryAuthenticatesWithPinnedTransport(t *testing.T) {
	var requests atomic.Int32
	password := strings.Repeat("memory-fixture", 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		user, secret, ok := r.BasicAuth()
		if !ok || user != "cliprelay" || secret != password || r.URL.Path != "/api/cliprelay/input" {
			t.Error("unexpected admin request")
		}
		_ = json.NewEncoder(w).Encode(inputFixture())
	}))
	defer server.Close()
	access, err := NewMemoryEngineAccess(password, server.Certificate().Raw)
	if err != nil {
		t.Fatal(err)
	}
	defer access.Close()
	secret, certificate, err := access.Read()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := requestEngineInput(context.Background(), server.URL, secret, certificate); err != nil {
		t.Fatal(err)
	}
	certificate[0] ^= 1
	if _, err := requestEngineInput(context.Background(), server.URL, secret, certificate); err == nil {
		t.Fatal("different pin accepted")
	}
	if requests.Load() != 1 {
		t.Fatal("credentials sent to an unverified listener")
	}
}

func TestEngineAccessClosedOwnerRefusesEveryProviderWithoutFileFallback(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	access, err := NewMemoryEngineAccess(strings.Repeat("fixture", 4), server.Certificate().Raw)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	// A valid legacy credential must never replace a revoked memory owner.
	legacy, _ := json.Marshal(map[string]string{"adminPassword": strings.Repeat("fallback", 4)})
	if err := os.WriteFile(filepath.Join(directory, "service.json"), legacy, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "cacert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pairer := newLANPairerWithAccess(ctx, directory, tls.Certificate{Certificate: [][]byte{server.Certificate().Raw}}, access.Read)
	access.Close()
	access.Close()
	_, _, readErr := access.Read()
	_, displayErr := engineDisplayProviderWithAccess(access.Read)(ctx, false, nil)
	_, bitrateErr := engineBitrateProviderWithAccess(access.Read)(ctx, "", nil)
	_, inputErr := engineInputProviderWithAccess(access.Read)(ctx)
	_, pairErr := pairer.engine(ctx, "GET", "/api/pin", nil)
	for _, err := range []error{readErr, displayErr, bitrateErr, inputErr, pairErr} {
		if !errors.Is(err, errEngineAccessUnavailable) {
			t.Fatal("closed owner did not fail before network access", err)
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 2 {
		t.Fatal("credential access changed private files")
	}
}

func TestEngineAccessMemoryCloseAndConcurrentReads(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	access, err := NewMemoryEngineAccess(strings.Repeat("fixture", 4), server.Certificate().Raw)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 32 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for range 32 {
				password, certificate, err := access.Read()
				if err == nil && (password == "" || !bytes.Equal(certificate, server.Certificate().Raw)) {
					t.Error("partially released credential observed")
				}
				if err != nil && (!errors.Is(err, errEngineAccessUnavailable) || password != "" || certificate != nil) {
					t.Error("closed owner exposed data")
				}
			}
		}()
	}
	access.Close()
	workers.Wait()
	if _, _, err := access.Read(); !errors.Is(err, errEngineAccessUnavailable) {
		t.Fatal("closed owner reopened")
	}
}

func TestEngineAccessLegacyFilesRemainAvailable(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	directory := t.TempDir()
	password := strings.Repeat("legacy", 4)
	settings, _ := json.Marshal(map[string]string{"adminPassword": password})
	if err := os.WriteFile(filepath.Join(directory, "service.json"), settings, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "cacert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	got, certificate, err := fileEngineAccess(directory)()
	if err != nil || got != password || !bytes.Equal(certificate, server.Certificate().Raw) {
		t.Fatal("legacy service credentials changed", err)
	}
}

func TestEngineAccessMissingProviderDoesNotStartTheService(t *testing.T) {
	directory := t.TempDir()
	if err := ServeWithEngineAccess(context.Background(), directory, "must-not-launch", nil); !errors.Is(err, errEngineAccessUnavailable) {
		t.Fatal(err)
	}
	var empty MemoryEngineAccess
	if err := ServeWithEngineAccess(context.Background(), directory, "must-not-launch", empty.Read); !errors.Is(err, errEngineAccessUnavailable) {
		t.Fatal("empty credential owner reached service startup", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatal("missing credentials created service state")
	}
}

func TestEngineAccessServerRejectsIdentityMismatchBeforeWorkersOrListeners(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	directory := t.TempDir()
	key, err := x509.MarshalPKCS8PrivateKey(server.TLS.Certificates[0].PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, block := range map[string]*pem.Block{
		"cacert.pem": {Type: "CERTIFICATE", Bytes: server.Certificate().Raw},
		"cakey.pem":  {Type: "PRIVATE KEY", Bytes: key},
	} {
		if err := os.WriteFile(filepath.Join(directory, name), pem.EncodeToMemory(block), 0600); err != nil {
			t.Fatal(err)
		}
	}
	access := func() (string, []byte, error) { return strings.Repeat("fixture", 4), []byte("another engine"), nil }
	if err := ServeWithEngineAccess(context.Background(), directory, "must-not-launch", access); !errors.Is(err, errEngineAccessUnavailable) {
		t.Fatal("mismatched service identity admitted", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 2 {
		t.Fatal("rejected service created IPC or state")
	}
}
