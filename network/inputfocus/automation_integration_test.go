package inputfocus

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestAutomationRealMCPToTLSAndWindowsControls(t *testing.T) {
	testAutomationRealNative(t, "automation-tls-real.cjs")
}

func TestAutomationRealCLIToTLSAndWindowsControls(t *testing.T) {
	if os.Getenv("CLIPRELAY_AUTOMATION_TEST_CLI") == "" {
		t.Skip("set the bundled ProfilePilot CLI path for CLI/TLS/Windows acceptance")
	}
	testAutomationRealNative(t, "automation-cli-real.cjs")
}

func testAutomationRealNative(t *testing.T, scriptName string) {
	executable := os.Getenv("CLIPRELAY_AUTOMATION_TEST_WORKER")
	fixture := os.Getenv("CLIPRELAY_AUTOMATION_TEST_FIXTURE")
	if executable == "" || fixture == "" {
		t.Skip("set native worker and isolated fixture paths for full MCP/TLS/Windows acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	worker := &probe{ctx: ctx, executable: executable, argument: "--automation-probe", maxOutput: 4 * 1024 * 1024, timeout: 40 * time.Second}
	defer worker.stop()
	clients := filepath.Join(t.TempDir(), "clients.json")
	cert := fileTestCertificate(t)
	filePairing(t, clients, cert.Certificate[0])
	control := &automationControl{clients: clients, read: worker.read}
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	hostCert := seed.TLS.Certificates[0]
	seed.Close()
	server := httptest.NewUnstartedServer(control.handler(http.NotFoundHandler()))
	server.TLS = controlTLSConfig(hostCert, clients)
	server.StartTLS()
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(endpoint.Port())
	digest := sha256.Sum256(hostCert.Certificate[0])
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs(filepath.Join("../../windows/tests", scriptName))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, "node", script)
	in, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"host": map[string]any{"id": hex.EncodeToString(digest[:]), "clientId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "name": "Isolated TLS fixture", "enabled": true, "address": endpoint.Hostname(), "port": port - 2, "certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: hostCert.Certificate[0]}))}, "identity": map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))}, "fixture": fixture}
	config["cli"] = os.Getenv("CLIPRELAY_AUTOMATION_TEST_CLI")
	if err = json.NewEncoder(in).Encode(config); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(out)
	complete := false
	for scanner.Scan() {
		var event struct {
			Phase string `json:"phase"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			t.Fatal("invalid integration output")
		}
		if event.Phase == "revoke" {
			filePairing(t, clients, []byte("replacement"))
			_, _ = io.WriteString(in, "revoked\n")
		}
		if event.Phase == "complete" {
			complete = true
		}
	}
	in.Close()
	if err = command.Wait(); err != nil {
		t.Fatal(fmt.Errorf("real automation integration: %w", err))
	}
	if !complete {
		t.Fatal("integration did not complete")
	}
	native := worker.cmd
	worker.stop()
	if native == nil || native.ProcessState == nil || !native.ProcessState.Success() {
		t.Fatal("automation worker did not exit cleanly on EOF")
	}
	t.Logf("%s -> private IPC -> pinned mutual TLS -> desktop-user worker -> actual Windows input and button; revocation and EOF verified", scriptName)
}
