//go:build darwin && cgo

package hostprivacy

/*
#cgo CFLAGS: -mmacosx-version-min=14.2 -fobjc-arc -fblocks
#cgo LDFLAGS: -mmacosx-version-min=14.2 -framework AppKit -framework Carbon
#include <stdlib.h>
#include "native_darwin.h"
*/
import "C"
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"
	"unsafe"
)

type nativeDesktop struct{}

func (nativeDesktop) Prepare() (Identity, error) {
	raw := C.cr_privacy_prepare()
	if raw == nil {
		return Identity{}, errors.New("PRIVACY_DESKTOP_UNAVAILABLE")
	}
	defer C.free(unsafe.Pointer(raw))
	var identity Identity
	if json.Unmarshal([]byte(C.GoString(raw)), &identity) != nil || !validIdentity(identity) || identity.PID != os.Getpid() {
		return Identity{}, errors.New("PRIVACY_DESKTOP_UNAVAILABLE")
	}
	return identity, nil
}
func (nativeDesktop) Show() error {
	if C.cr_privacy_show() != 1 {
		return errors.New("PRIVACY_DESKTOP_UNAVAILABLE")
	}
	return nil
}
func (nativeDesktop) Healthy() bool { return C.cr_privacy_healthy() == 1 }
func (nativeDesktop) Hide() error {
	if C.cr_privacy_hide() != 1 {
		return errors.New("PRIVACY_RESTORE_FAILED")
	}
	return nil
}

// RunNative must run on the initial OS thread, locked by main's init. It is
// called only after the companion validates a direct owner and private pipes.
func RunNative(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if C.cr_privacy_bootstrap() != 1 {
		return errors.New("PRIVACY_DESKTOP_UNAVAILABLE")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	controller := New(nativeDesktop{}, time.Now)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		for {
			var timer *time.Timer
			var expiry <-chan time.Time
			if deadline := controller.Deadline(); !deadline.IsZero() {
				timer = time.NewTimer(time.Until(deadline))
				expiry = timer.C
			}
			withdrawn := false
			select {
			case <-finished:
				if timer != nil {
					timer.Stop()
				}
				return
			case <-ctx.Done():
				withdrawn = true
			case <-controller.Withdrawn():
				withdrawn = true
			case <-controller.DeadlineChanged():
			case <-expiry:
				deadline := controller.Deadline()
				if !deadline.IsZero() && !time.Now().Before(deadline) {
					os.Exit(3)
				}
			}
			if timer != nil {
				timer.Stop()
			}
			if withdrawn {
				select {
				case <-finished:
					return
				case <-time.After(250 * time.Millisecond):
					os.Exit(2)
				}
			}
		}
	}()
	result := make(chan error, 1)
	go func() {
		err := Serve(ctx, input, output, controller)
		result <- err
		C.cr_privacy_finish()
	}()
	C.cr_privacy_run()
	cancel()
	return <-result
}
