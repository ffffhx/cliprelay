package inputfocus

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestProbeOwnerCancelledBeforeLaunch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := &probe{ctx: ctx, executable: filepath.Join(t.TempDir(), "must-not-execute")}
	if _, err := p.read("pid"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled owner attempted launch: %v", err)
	}
	if p.cmd != nil {
		t.Fatal("cancelled owner retained a worker")
	}
}

func buildProbeOwnerFixture(t *testing.T) string {
	t.Helper()
	executable := filepath.Join(t.TempDir(), "probe-owner")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	buildCtx, cancelBuild := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelBuild()
	if output, err := exec.CommandContext(buildCtx, "go", "build", "-o", executable, "./testdata/probe-owner").CombinedOutput(); err != nil {
		t.Fatalf("build disposable worker: %v\n%s", err, output)
	}
	return executable
}

func TestProbeOwnerProcessLifecycle(t *testing.T) {
	executable := buildProbeOwnerFixture(t)
	newProbe := func(t *testing.T, ctx context.Context) *probe {
		t.Helper()
		p := &probe{ctx: ctx, executable: executable, timeout: 15 * time.Second}
		t.Cleanup(p.close)
		return p
	}

	t.Run("graceful EOF reaps and final close rejects restart", func(t *testing.T) {
		p := newProbe(t, nil)
		cmd := probeOwnerReply(t, p, "pid", false)
		stopProbes(nil, p)
		probeOwnerReaped(t, p, cmd, true)
		if _, err := p.read("pid"); err == nil {
			t.Fatal("ordinary request restarted closed owner")
		}
		if _, err := p.readCleanup("cleanup"); err == nil || p.cmd != nil {
			t.Fatal("late cleanup restarted closed owner")
		}
	})

	t.Run("blocked command cancellation joins then permits restoration", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := newProbe(t, ctx)
		cmd := probeOwnerReply(t, p, "pid", false)
		marker := filepath.Join(t.TempDir(), "worker-ready")
		done := make(chan error, 1)
		go func() { _, err := p.read("wait:" + marker); done <- err }()
		probeOwnerReady(t, marker)
		start := time.Now()
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled read: %v", err)
			}
		case <-time.After(6 * time.Second):
			t.Fatal("cancelled request still waiting on its 15-second command timeout")
		}
		t.Logf("blocked request cancelled and child reaped in %s", time.Since(start))
		probeOwnerReaped(t, p, cmd, false)
		if _, err := p.read("pid"); !errors.Is(err, context.Canceled) || p.cmd != nil {
			t.Fatal("cancelled owner admitted another ordinary request")
		}
		// Restoration is allowed until final teardown, even if it requires a
		// new worker to recover state left by the previous process.
		cleanup := probeOwnerReply(t, p, "cleanup", true)
		stopProbes(p)
		probeOwnerReaped(t, p, cleanup, true)
		if _, err := p.readCleanup("cleanup"); err == nil || p.cmd != nil {
			t.Fatal("restoration restarted an owner after final teardown")
		}
	})

	t.Run("independent unresponsive workers get simultaneous grace periods", func(t *testing.T) {
		var workers []*probe
		var children []*exec.Cmd
		for i := 0; i < 3; i++ {
			p := newProbe(t, context.Background())
			children = append(children, probeOwnerReply(t, p, "ignore-eof", false))
			workers = append(workers, p)
		}
		start := time.Now()
		stopProbes(workers...)
		elapsed := time.Since(start)
		// Sequential shutdown would take at least 10.5 seconds. Allow enough
		// scheduling margin for Windows/macOS CI and Linux's race detector.
		if elapsed >= 7*time.Second {
			t.Fatalf("worker grace periods were not concurrent: %s", elapsed)
		}
		t.Logf("three unresponsive workers closed and reaped in %s", elapsed)
		for i, p := range workers {
			probeOwnerReaped(t, p, children[i], false)
		}
	})

	t.Run("cleanup keeps its command deadline after cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		p := newProbe(t, ctx)
		cmd := probeOwnerReply(t, p, "pid", false)
		cancel()
		p.timeout = 100 * time.Millisecond
		marker := filepath.Join(t.TempDir(), "cleanup-ready")
		_, err := p.readCleanup("wait:" + marker)
		if err == nil || err.Error() != "focus timeout" {
			t.Fatalf("cleanup lost its bounded deadline: %v", err)
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("cleanup never reached worker: %v", err)
		}
		probeOwnerReaped(t, p, cmd, false)
	})
}

func probeOwnerReply(t *testing.T, p *probe, command string, cleanup bool) *exec.Cmd {
	t.Helper()
	read := p.read
	if cleanup {
		read = p.readCleanup
	}
	raw, err := read(command)
	var reply struct {
		PID     int    `json:"pid"`
		Command string `json:"command"`
	}
	if err != nil || json.Unmarshal(raw, &reply) != nil || p.cmd == nil || reply.PID != p.cmd.Process.Pid || reply.Command != command {
		t.Fatalf("worker reply did not identify the actual owned process: %s, %v", raw, err)
	}
	return p.cmd
}

func probeOwnerReady(t *testing.T, marker string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(marker); err == nil && string(raw) == "ready" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("worker did not acknowledge the blocking command")
}

func probeOwnerReaped(t *testing.T, p *probe, cmd *exec.Cmd, graceful bool) {
	t.Helper()
	if p.cmd != nil || cmd.ProcessState == nil {
		t.Fatal("worker owner returned before Wait completed")
	}
	if cmd.ProcessState.Success() != graceful {
		t.Fatalf("unexpected worker exit (graceful=%t): %v", graceful, cmd.ProcessState)
	}
}
