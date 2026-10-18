//go:build darwin || linux

package hostcompanion

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cliprelay/network/inputfocus"
)

func privateFixture(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "cr-host-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestHostCompanionOwnerEOFAndProtocolViolationJoinService(t *testing.T) {
	for _, action := range []string{"eof", "extra-byte", "owner-cancel"} {
		t.Run(action, func(t *testing.T) {
			state := privateFixture(t)
			input, parentInput := io.Pipe()
			parentOutput, output := io.Pipe()
			defer parentInput.Close()
			defer parentOutput.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var retained inputfocus.EngineAccess
			cancelled, release := make(chan struct{}), make(chan struct{})
			serving := make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			done := make(chan error, 1)
			finished := make(chan struct{})
			t.Cleanup(func() {
				cancel()
				select {
				case <-finished:
				case <-time.After(3 * time.Second):
					t.Error("fixture session did not join")
				}
			})
			go func() {
				defer close(finished)
				done <- Run(ctx, input, output, state, 2345, func(ctx context.Context, stateDir, runtimeDir string, access inputfocus.EngineAccess, listening func() error) error {
					retained = access
					if stateDir != state || runtimeDir == state {
						t.Error("persistent/runtime state was not separated")
					}
					if _, _, err := access(); err != nil {
						return err
					}
					listener, err := net.Listen("unix", filepath.Join(runtimeDir, "clipboard-relay.sock"))
					if err != nil {
						return err
					}
					defer listener.Close()
					if err := listening(); err != nil {
						return err
					}
					close(serving)
					<-ctx.Done()
					close(cancelled)
					<-release
					return ctx.Err()
				})
			}()
			if _, err := parentInput.Write(credentialFixture(t)); err != nil {
				t.Fatal(err)
			}
			line, err := bufio.NewReader(parentOutput).ReadBytes('\n')
			if err != nil {
				t.Fatal(err)
			}
			var status struct {
				Type                    string
				Protocol, PID, OwnerPID int
				IPC                     string
				NativeWorkers           bool
			}
			if json.Unmarshal(line, &status) != nil || status.Type != "listening" || status.Protocol != 1 || status.PID != os.Getpid() || status.OwnerPID != 2345 || status.NativeWorkers {
				t.Fatal("invalid service status", string(line))
			}
			if _, err := os.Stat(status.IPC); err != nil {
				t.Fatal(err)
			}
			// Reading the pipe's bytes can precede the writer's completion
			// notification. Admit the test service before testing active shutdown.
			select {
			case <-serving:
			case <-time.After(time.Second):
				t.Fatal("fixture did not finish listening acknowledgement")
			}
			switch action {
			case "eof":
				parentInput.Close()
			case "extra-byte":
				_, _ = parentInput.Write([]byte("x"))
			case "owner-cancel":
				cancel()
			}
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("service was not cancelled")
			}
			select {
			case err := <-done:
				t.Fatal("returned before service joined", err)
			default:
			}
			close(release)
			select {
			case err := <-done:
				if action == "extra-byte" {
					if err == nil || err.Error() != "HOST_PROTOCOL_INVALID" {
						t.Fatal("protocol violation hidden", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("service was not joined")
			}
			if _, _, err := retained(); err == nil {
				t.Fatal("credentials remained available after service exit")
			}
			if _, err := os.Lstat(filepath.Dir(status.IPC)); !os.IsNotExist(err) {
				t.Fatal("runtime directory survived exit", err)
			}
			if entries, err := os.ReadDir(state); err != nil || len(entries) != 0 {
				t.Fatal("session wrote credentials into persistent state", err)
			}
		})
	}
}

func TestHostCompanionCancellationDuringListeningAcknowledgement(t *testing.T) {
	state := privateFixture(t)
	input, parentInput := io.Pipe()
	parentOutput, output := io.Pipe()
	defer parentInput.Close()
	defer parentOutput.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, input, output, state, 2345, func(_ context.Context, _, runtimeDir string, _ inputfocus.EngineAccess, listening func() error) error {
			entered <- runtimeDir
			return listening() // Deliberately blocked because the owner is not reading.
		})
	}()
	if _, err := parentInput.Write(credentialFixture(t)); err != nil {
		t.Fatal(err)
	}
	var runtimeDir string
	select {
	case runtimeDir = <-entered:
	case <-time.After(time.Second):
		t.Fatal("fixture did not enter readiness")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("owner cancellation changed into startup failure", err)
		}
	case <-time.After(time.Second):
		t.Fatal("readiness write prevented shutdown")
	}
	if _, err := os.Lstat(runtimeDir); !os.IsNotExist(err) {
		t.Fatal("cancelled startup retained runtime directory", err)
	}
}

func TestHostCompanionPrivateStateBoundary(t *testing.T) {
	root := privateFixture(t)
	if err := validateState(root); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "fixture")
	if err := os.WriteFile(file, []byte("private fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateState(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateState(root); err == nil {
		t.Fatal("public state accepted")
	}
	if err := os.Chmod(file, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Link(file, link); err != nil {
		t.Fatal(err)
	}
	if err := validateState(root); err == nil {
		t.Fatal("hard-linked state accepted")
	}
	os.Remove(link)
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if err := validateState(root); err == nil {
		t.Fatal("symbolic state accepted")
	}
	os.Remove(link)
	listener, err := net.Listen("unix", filepath.Join(root, "must-be-transient.sock"))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateState(root); err == nil {
		t.Fatal("runtime socket accepted as persistent state")
	}
	listener.Close()
}

func TestHostCompanionRuntimeCleanupRefusesUnexpectedFiles(t *testing.T) {
	runtime, err := newRuntime()
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(runtime.path, "unowned-file")
	defer func() { os.Remove(file); _ = runtime.close() }()
	if err := os.WriteFile(file, []byte("retain me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runtime.close(); err == nil || err.Error() != "HOST_RUNTIME_CLEANUP_FAILED" {
		t.Fatal("unexpected content deleted", err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "retain me" {
		t.Fatal("runtime cleanup changed unrelated data")
	}
}
