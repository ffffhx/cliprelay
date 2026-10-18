package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDesktopClientRealBrokerApprovalAndRevocation(t *testing.T) {
	runtime := os.Getenv("CLIPRELAY_DESKTOP_NODE")
	if runtime == "" {
		runtime = "node"
	}
	node, err := exec.LookPath(runtime)
	if err != nil {
		t.Fatal("Node is required for the desktop broker interoperability test")
	}
	s, control := fixture(t)
	host := credential("h")
	hostID := call(t, s, "POST", "/v1/hosts", host, `{"name":"Host fixture"}`, 201)["id"].(string)
	call(t, s, "POST", "/v1/enroll", host, `{}`, 200)
	remote := NetworkNode{ID: "81", IPs: []string{"100.64.0.2"}, Online: true}
	remote.User.ID = "1"
	remote.PreAuthKey.ID = "1"
	control.nodes = []NetworkNode{remote}
	server := httptest.NewTLSServer(http.StripPrefix("/network", s.Handler()))
	defer server.Close()
	script, err := filepath.Abs("../../windows/tests/network-broker-real.cjs")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, script)
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); command.Process.Kill() }()
	publicCA := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))
	json.NewEncoder(input).Encode(map[string]string{"endpoint": server.URL + "/network", "ca": publicCA, "code": code(t, s, host), "hostId": hostID})
	scanner := bufio.NewScanner(output)
	next := func(phase string) map[string]any {
		t.Helper()
		if !scanner.Scan() {
			t.Fatalf("desktop broker stopped before %s", phase)
		}
		var value map[string]any
		if json.Unmarshal(scanner.Bytes(), &value) != nil || value["phase"] != phase {
			t.Fatalf("invalid desktop protocol phase %s", phase)
		}
		return value
	}
	claimed := next("claimed")
	id, ok := claimed["id"].(string)
	if !ok {
		t.Fatal("missing desktop claim ID")
	}
	call(t, s, "POST", "/v1/approve", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	io.WriteString(input, "approved\n")
	next("enrolled")
	call(t, s, "POST", "/v1/revoke", host, fmt.Sprintf(`{"id":%q}`, id), 200)
	io.WriteString(input, "revoked\n")
	if next("complete")["passed"] != true {
		t.Fatal("desktop client failed to confirm revocation")
	}
	input.Close()
	if err = command.Wait(); err != nil {
		t.Fatal("desktop client exited unsuccessfully", err)
	}
	if control.keys != 2 || len(control.expired) != 1 {
		t.Fatal("unexpected enrollment or revocation count")
	}
	t.Log("Real HTTPS broker: pending desktop cannot enroll, host approval unlocks exact peer, revoked credential is rejected")
}
