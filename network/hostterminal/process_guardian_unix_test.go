//go:build (darwin || linux) && cgo

package hostterminal

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func guardianCommand(t *testing.T, mode, shell string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestProcessGuardianHelper$")
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "CLIPRELAY_GUARDIAN_TEST=") && !strings.HasPrefix(value, "CLIPRELAY_GUARDIAN_PARENT=") && !strings.HasPrefix(value, "CLIPRELAY_GUARDIAN_SHELL=") {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "CLIPRELAY_GUARDIAN_TEST="+mode, "CLIPRELAY_GUARDIAN_PARENT="+strconv.Itoa(os.Getpid()), "CLIPRELAY_GUARDIAN_SHELL="+shell)
	return command
}
func guardianTestPipe(file *os.File) (*os.File, error) {
	fd, err := unix.FcntlInt(file.Fd(), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return nil, err
	}
	if err = unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "guardian-test-pipe"), nil
}
func TestProcessGuardianHelper(t *testing.T) {
	mode := os.Getenv("CLIPRELAY_GUARDIAN_TEST")
	if mode == "" {
		return
	}
	nativeOnly(t)
	owner, err := strconv.Atoi(os.Getenv("CLIPRELAY_GUARDIAN_PARENT"))
	if err != nil || owner <= 1 || owner != os.Getppid() {
		os.Exit(2)
	}
	if mode == "owner" {
		buffer := NewBuffer()
		child, err := StartGuarded(guardianCommand(t, "session", "bash"), buffer.Append)
		if err != nil {
			os.Exit(2)
		}
		pid := guardianShellPID(t, child, buffer)
		// The external test kills this owner abruptly. The guardian must observe
		// reparenting even if EOF were delayed by an inherited pipe elsewhere.
		_ = json.NewEncoder(os.Stdout).Encode(map[string]int{"shell": pid, "guardian": child.(*guardedProcess).command.Process.Pid})
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		child.Close()
		<-child.Done()
		os.Exit(0)
	}
	input, err := guardianTestPipe(os.Stdin)
	if err != nil {
		os.Exit(2)
	}
	output, err := guardianTestPipe(os.Stdout)
	if err != nil {
		os.Exit(2)
	}
	_ = os.Stdin.Close()
	_ = os.Stdout.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != owner {
					cancel()
					return
				}
			}
		}
	}()
	if mode == "bad-state" {
		_ = writeProcessFrame(output, processEvent{Op: "ready", State: &ProcessState{}}, ReplyLimit)
		_, _ = bufio.NewReader(input).ReadString('\n')
		_ = writeProcessFrame(output, processEvent{Op: "state", State: &ProcessState{Written: 99}}, ReplyLimit)
		_, _ = bufio.NewReader(input).ReadString('\n')
		os.Exit(0)
	}
	err = ServeProcess(ctx, input, output, os.Getenv("CLIPRELAY_GUARDIAN_SHELL"), 100, 30, StartNative)
	cancel()
	if err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}
func guardianShellPID(t *testing.T, p Process, b *Buffer) int {
	t.Helper()
	nativeWrite(t, p, 1, "printf '\\nCLIPRELAY_CHILD_%s_END\\n' \"$$\"\r", false)
	var pid int
	eventually(t, 5*time.Second, func() bool {
		for _, line := range strings.Split(contents(b), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "CLIPRELAY_CHILD_") && strings.HasSuffix(line, "_END") {
				pid, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(line, "CLIPRELAY_CHILD_"), "_END"))
				if pid > 1 {
					return true
				}
			}
		}
		return false
	})
	return pid
}
func guardianFixture(t *testing.T, shell string) (Process, *Buffer) {
	t.Helper()
	nativeOnly(t)
	buffer := NewBuffer()
	process, err := StartGuarded(guardianCommand(t, "session", shell), buffer.Append)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		process.Close()
		select {
		case <-process.Done():
		case <-time.After(6 * time.Second):
			t.Error("guardian not joined")
		}
	})
	return process, buffer
}
func TestGuardianNativeShellUnicodeResizeAndExit(t *testing.T) {
	shells := []string{"bash"}
	if runtime.GOOS == "darwin" {
		shells = append(shells, "zsh")
	}
	for _, shell := range shells {
		t.Run(shell, func(t *testing.T) {
			p, b := guardianFixture(t, shell)
			pid := guardianShellPID(t, p, b)
			marker := "guarded-中文-👋"
			nativeWrite(t, p, 2, "printf '\\n"+octal(marker)+"\\n'\r", false)
			eventually(t, 5*time.Second, func() bool { return strings.Contains(contents(b), marker) && p.Status().Written == 2 })
			if err := p.Resize(120, 40); err != nil {
				t.Fatal(err)
			}
			nativeWrite(t, p, 3, "printf '\\n'; stty size\r", false)
			eventually(t, 5*time.Second, func() bool { return strings.Contains(contents(b), "40 120") })
			nativeWrite(t, p, 4, "exit 7\r", false)
			select {
			case <-p.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("natural exit not joined")
			}
			if s := p.Status(); !s.Exited || s.Failed || s.ExitCode != 7 || s.Written != 4 {
				t.Fatalf("wrong guardian exit: %+v", s)
			}
			if err := unix.Kill(pid, 0); err != unix.ESRCH {
				t.Fatal("owned native shell retained", err)
			}
		})
	}
}
func TestGuardianEOFClosesForegroundJobAndReapsShell(t *testing.T) {
	p, b := guardianFixture(t, "bash")
	pid := guardianShellPID(t, p, b)
	nativeWrite(t, p, 2, "trap '' HUP; sleep 60\r", false)
	eventually(t, time.Second, func() bool { return p.Status().Written == 2 })
	p.Close()
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("EOF did not join")
	}
	if unix.Kill(pid, 0) != unix.ESRCH {
		t.Fatal("shell survived helper EOF")
	}
	if p.Queue([]byte("late\r"), 3, false) {
		t.Fatal("closed guardian accepted input")
	}
}

func TestGuardianWholePasteAndOutputRing(t *testing.T) {
	p, b := guardianFixture(t, "bash")
	body := strings.Repeat("a", 14000)
	want := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	nativeWrite(t, p, 1, "printf '%s' '"+body+"' | shasum -a 256\r", true)
	eventually(t, 8*time.Second, func() bool { return strings.Contains(contents(b), want) && p.Status().Written == 1 })
	marker := "guarded-output-end"
	nativeWrite(t, p, 2, "head -c 1200000 /dev/zero | tr '\\000' a; printf '\\n"+octal(marker)+"\\n'\r", false)
	eventually(t, 10*time.Second, func() bool { return strings.Contains(contents(b), marker) && p.Status().Written == 2 })
	start, end := b.Bounds()
	if start <= 0 || end-start != OutputLimit || p.Status().Failed || p.Status().Exited {
		t.Fatalf("output was lost at guardian instead of retained ring: %d %d %+v", start, end, p.Status())
	}
}
func TestGuardianRejectsImpossibleWrittenReceipt(t *testing.T) {
	nativeOnly(t)
	p, err := StartGuarded(guardianCommand(t, "bad-state", "bash"), func([]byte) {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); <-p.Done() })
	if !p.Queue([]byte("x"), 1, false) {
		t.Fatal("queue")
	}
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("invalid guardian was not joined")
	}
	if s := p.Status(); !s.Failed || s.Written != 0 {
		t.Fatalf("accepted impossible receipt: %+v", s)
	}
}
func TestGuardianSurvivesOwnerKillOnlyUntilShellIsReaped(t *testing.T) {
	nativeOnly(t)
	command := guardianCommand(t, "owner", "bash")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		_ = input.Close()
		if !waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	result := make(chan map[string]int, 1)
	go func() { var info map[string]int; _ = json.NewDecoder(output).Decode(&info); result <- info }()
	var info map[string]int
	select {
	case info = <-result:
	case <-time.After(10 * time.Second):
		t.Fatal("owner did not start native shell")
	}
	if info["shell"] <= 1 || info["guardian"] <= 1 {
		t.Fatal("missing owned PIDs")
	}
	if err = command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	waited = true
	eventually(t, 5*time.Second, func() bool { return unix.Kill(info["shell"], 0) == unix.ESRCH })
	// macOS/Linux init may briefly retain an orphan's zombie, so the proof of
	// shell reaping is independent of when PID 1 collects the finished guardian.
	t.Log(fmt.Sprintf("owner death reaped native shell via guardian %d", info["guardian"]))
}
