//go:build (darwin || linux) && cgo

package hostterminal

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func nativeOnly(t *testing.T) {
	t.Helper()
	if os.Getenv("CI") != "true" || os.Getenv("GITHUB_ACTIONS") != "true" {
		t.Skip("native shells run only on disposable CI")
	}
	if os.Geteuid() == 0 {
		t.Fatal("native terminal acceptance requires an ordinary user")
	}
}
func eventually(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("terminal condition did not become true")
}
func contents(buffer *Buffer) string {
	start, end := buffer.Bounds()
	result := []byte{}
	for start < end {
		data, offset, _, err := buffer.Read(start)
		if err != nil {
			return "invalid output"
		}
		result = append(result, data...)
		start = offset + int64(len(data))
	}
	return string(result)
}
func octal(value string) string {
	var text strings.Builder
	for _, b := range []byte(value) {
		fmt.Fprintf(&text, "\\%03o", b)
	}
	return text.String()
}
func nativeFixture(t *testing.T, shell string) (Process, *Buffer) {
	t.Helper()
	nativeOnly(t)
	buffer := NewBuffer()
	process, err := StartNative(shell, 100, 30, buffer.Append)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			value := contents(buffer)
			if len(value) > 1200 {
				value = value[:500] + " ... " + value[len(value)-700:]
			}
			t.Logf("native state: %+v; synthetic output: %q", process.Status(), value)
		}
		process.Close()
		select {
		case <-process.Done():
		case <-time.After(5 * time.Second):
			t.Error("native process was not joined")
		}
	})
	return process, buffer
}
func nativeWrite(t *testing.T, p Process, sequence int64, command string, paste bool) {
	t.Helper()
	if !p.Queue([]byte(command), sequence, paste) {
		t.Fatal("native input rejected")
	}
}

func TestNativePTYUnicodeResizeAndExit(t *testing.T) {
	shells := []string{"bash"}
	if runtime.GOOS == "darwin" {
		shells = append(shells, "zsh")
	}
	for _, shell := range shells {
		t.Run(shell, func(t *testing.T) {
			p, b := nativeFixture(t, shell)
			marker := "PTY-native-中文-👋"
			nativeWrite(t, p, 1, "test -t 0 && test -t 1 && printf '\\n"+octal(marker)+"\\n'\r", false)
			eventually(t, 5*time.Second, func() bool { return strings.Contains(contents(b), marker) })
			if err := p.Resize(120, 40); err != nil {
				t.Fatal(err)
			}
			nativeWrite(t, p, 2, "printf '\\n'; stty size\r", false)
			eventually(t, 5*time.Second, func() bool { return strings.Contains(contents(b), "\r\n40 120\r\n") })
			nativeWrite(t, p, 3, "exit 7\r", false)
			select {
			case <-p.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("shell exit was not reaped")
			}
			state := p.Status()
			if !state.Exited || state.ExitCode != 7 || state.Written != 3 || state.Failed {
				t.Fatal(state)
			}
			pid := p.(*nativeProcess).command.Process.Pid
			if err := unix.Kill(pid, 0); err != unix.ESRCH {
				t.Fatal("reaped shell still exists", pid, err)
			}
		})
	}
}
func TestNativeWholePasteAndWriteReceipt(t *testing.T) {
	p, b := nativeFixture(t, "bash")
	body := strings.Repeat("a", 14000)
	want := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	nativeWrite(t, p, 1, "printf '%s' '"+body+"' | shasum -a 256\r", true)
	eventually(t, 8*time.Second, func() bool { return strings.Contains(contents(b), want) })
	if p.Status().Written != 1 {
		t.Fatal("whole paste was not confirmed", p.Status())
	}
}
func TestNativeManagerLostReplyRevocationAndReopen(t *testing.T) {
	nativeOnly(t)
	start := time.Now()
	manager := New(func() int64 { return time.Since(start).Milliseconds() }, StartNative)
	t.Cleanup(func() {
		for _, p := range manager.Close() {
			select {
			case <-p.Done():
			case <-time.After(5 * time.Second):
				t.Error("manager child not joined")
			}
		}
	})
	owner := strings.Repeat("a", 64)
	check(t, manager.Handle(Request{Op: "sync", Owners: []string{owner}}), "")
	list := manager.Handle(Request{Op: "list", Owner: owner})
	open := Request{Op: "open", Owner: owner, Instance: list.Instance, ID: strings.Repeat("b", 32), Shell: "bash", Columns: 100, Rows: 30, Sequence: 1}
	check(t, manager.Handle(open), "")
	check(t, manager.Handle(open), "")
	marker := "native-lost-reply-once"
	write := input(open, 1, "printf '\\n"+octal(marker)+"\\n'\r")
	check(t, manager.Handle(write), "")
	check(t, manager.Handle(write), "")
	var output string
	eventually(t, 5*time.Second, func() bool {
		reply := manager.Handle(command(open, "read"))
		check(t, reply, "")
		data, err := base64.StdEncoding.DecodeString(reply.Data)
		if err != nil {
			t.Fatal(err)
		}
		output = string(data)
		return strings.Contains(output, marker) && reply.Session.WrittenSequence == 1
	})
	if strings.Count(output, marker) != 1 {
		t.Fatal("lost reply duplicated command", output)
	}
	process := manager.processes[0]
	check(t, manager.Handle(Request{Op: "sync", Owners: []string{}}), "")
	select {
	case <-process.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("revoked shell not joined")
	}
	check(t, manager.Handle(command(open, "read")), "TERMINAL_UNPAIRED")
	check(t, manager.Handle(Request{Op: "sync", Owners: []string{owner}}), "")
	reply := manager.Handle(command(open, "read"))
	check(t, reply, "")
	if reply.Session.State != "revoked" {
		t.Fatal(reply)
	}
}
func TestNativeCloseCancelsForegroundCommandAndIO(t *testing.T) {
	p, b := nativeFixture(t, "bash")
	marker := "before-foreground-sleep"
	nativeWrite(t, p, 1, "printf '\\n"+octal(marker)+"\\n'; sleep 60\r", false)
	eventually(t, 5*time.Second, func() bool { return strings.Contains(contents(b), marker) })
	p.Close()
	select {
	case <-p.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("foreground command blocked native shutdown")
	}
	if p.Queue([]byte("late"), 2, false) {
		t.Fatal("closed process accepted input")
	}
}
