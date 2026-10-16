package inputfocus

import (
	"encoding/json"
	"testing"
)

func TestTerminalHostShellInventory(t *testing.T) {
	f, h := terminalFixtureNew(t)
	call := func() int { return fileCall(h, []byte("first"), "POST", "/v1/terminal", terminalListBody()).Code }
	if call() != 200 {
		t.Fatal("legacy Windows inventory rejected")
	}
	f.result.Shells = []string{"zsh", "bash"}
	f.result.NextOpen = 2
	f.result.Sessions = []terminalSession{{ID: privacyTestLease, Shell: "zsh", State: "running", Columns: 80, Rows: 24, OpenSequence: 1}}
	if call() != 200 {
		t.Fatal("Mac inventory rejected")
	}
	for _, shells := range [][]string{nil, {"cmd"}, {"zsh", "zsh"}, {"/bin/zsh"}, {"zsh", "fish"}} {
		f.result.Shells = shells
		if call() != 503 {
			t.Fatalf("accepted inconsistent inventory %v", shells)
		}
	}
	for _, field := range []string{`"shells":null`, `"shells":[]`, `"shells":"zsh"`, `"shells":[1]`, `"Shells":["zsh"]`} {
		var value terminalReply
		err := json.Unmarshal([]byte(`{"ok":true,"instance":"`+terminalTestInstance+`","nextOpen":1,`+field+`}`), &value)
		if err == nil && validTerminalReply(terminalRequest{Op: "list"}, value) {
			t.Fatal("accepted malformed inventory", field)
		}
	}
	sequence := int64(1)
	for _, shell := range []string{"zsh", "bash", "cmd", "powershell"} {
		r := terminalRequest{Op: "open", Instance: terminalTestInstance, ID: privacyTestLease, Shell: shell, Columns: 80, Rows: 24, Sequence: &sequence}
		if !validTerminalRequest(r) {
			t.Fatal("valid host shell rejected", shell)
		}
		r.Shell = "/bin/" + shell
		if validTerminalRequest(r) {
			t.Fatal("client supplied executable path accepted")
		}
	}
}
