//go:build (darwin || linux) && cgo

package hostterminal

import (
	"encoding/base64"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNativeMouseReceiver(t *testing.T) {
	if os.Getenv("CLIPRELAY_NATIVE_MOUSE_RECEIVER") != "1" {
		return
	}
	nativeOnly(t)
	// The disposable foreground test program deliberately enables mouse input.
	// Its stdin is the actual slave PTY, independent of the provider's policy.
	fmt.Print("\x1b[?1002;1006hNATIVE_MOUSE_READY\r\n")
	done := make(chan []byte, 1)
	go func() {
		var captured []byte
		buffer := make([]byte, 512)
		for len(captured) < 8192 {
			n, err := os.Stdin.Read(buffer)
			captured = append(captured, buffer[:n]...)
			if err != nil || strings.HasSuffix(string(captured), "m") {
				done <- captured
				return
			}
		}
		done <- nil
	}()
	select {
	case captured := <-done:
		if len(captured) == 0 {
			os.Exit(2)
		}
		fmt.Printf("\x1b[?1002;1006l\r\nNATIVE_MOUSE_CAPTURE_%s_END\r\n", base64.StdEncoding.EncodeToString(captured))
		os.Exit(0)
	case <-time.After(8 * time.Second):
		os.Exit(2)
	}
}

func TestNativeTypedMouseOrderedInputAndCleanup(t *testing.T) {
	shells := []string{"bash"}
	if runtime.GOOS == "darwin" {
		shells = append(shells, "zsh")
	}
	for _, shell := range shells {
		for _, reason := range []string{"expiry", "resize"} {
			t.Run(shell+"/"+reason, func(t *testing.T) {
				p, b := nativeFixture(t, shell)
				native := p.(*nativeProcess)
				executable, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				quoted := "'" + strings.ReplaceAll(executable, "'", "'\\''") + "'"
				nativeWrite(t, p, 1, "stty -icanon -echo; CLIPRELAY_NATIVE_MOUSE_RECEIVER=1 "+quoted+" -test.run=^TestNativeMouseReceiver$; stty sane\r", false)
				eventually(t, 5*time.Second, func() bool {
					return strings.Contains(contents(b), "NATIVE_MOUSE_READY") && native.MouseState().Mode == 1002 && native.MouseState().Format == 1006
				})
				epoch := native.MouseState().Epoch
				press := MouseCommand{Sequence: 1, Action: "press", Epoch: epoch, Gesture: 1, Column: 5, Row: 7}
				nativeWrite(t, p, 2, "KEY-", false)
				if err := native.Mouse(press); err != nil {
					t.Fatal(err)
				}
				nativeWrite(t, p, 3, "PASTE-", true)
				move := press
				move.Sequence, move.Action, move.Column, move.Row = 2, "move", 90, 25
				if err := native.Mouse(move); err != nil {
					t.Fatal(err)
				}
				eventually(t, time.Second, func() bool { return native.MouseState().WrittenSequence == 2 && p.Status().Written == 3 })
				// A lost reply must not repeat the move or extend the drag lease.
				if err := native.Mouse(move); err != nil {
					t.Fatal(err)
				}
				release := "\x1b[<0;90;25m"
				if reason == "resize" {
					if err := p.Resize(20, 10); err != nil {
						t.Fatal(err)
					}
					stale := move
					stale.Sequence = 3
					mouseError(t, native.Mouse(stale), "TERMINAL_MOUSE_MODE")
					release = "\x1b[<0;20;10m"
				}
				var captured []byte
				eventually(t, 4*time.Second, func() bool {
					for _, line := range strings.Split(contents(b), "\n") {
						line = strings.TrimSpace(line)
						if strings.HasPrefix(line, "NATIVE_MOUSE_CAPTURE_") && strings.HasSuffix(line, "_END") {
							captured, err = base64.StdEncoding.DecodeString(strings.TrimSuffix(strings.TrimPrefix(line, "NATIVE_MOUSE_CAPTURE_"), "_END"))
							return err == nil
						}
					}
					return false
				})
				want := "KEY-\x1b[<0;5;7MPASTE-\x1b[<32;90;25M" + release
				if string(captured) != want {
					t.Fatalf("actual PTY bytes %q != %q", captured, want)
				}
				state := native.MouseState()
				if state.Buttons != 0 || state.WrittenSequence != 2 || state.AcceptedSequence != 2 || p.Status().Written != 3 || p.Status().Failed {
					t.Fatalf("incorrect native receipts: %+v %+v", state, p.Status())
				}
			})
		}
	}
}
