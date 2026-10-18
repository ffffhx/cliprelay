//go:build darwin && cgo

package hostaudio

/*
#cgo CFLAGS: -mmacosx-version-min=14.2 -fobjc-arc
#cgo LDFLAGS: -mmacosx-version-min=14.2 -framework Foundation -framework CoreAudio
#include "native_darwin.h"
*/
import "C"
import (
	"context"
	"errors"
	"io"
	"os"
	"time"
)

type nativeOutput struct{}

func (nativeOutput) Outputs() (int, error) {
	value := int(C.cr_audio_outputs())
	if value < 0 {
		return 0, errors.New("AUDIO_UNAVAILABLE")
	}
	return value, nil
}
func (nativeOutput) Start() error {
	if C.cr_audio_start() != 1 {
		return errors.New("AUDIO_UNAVAILABLE")
	}
	return nil
}
func (nativeOutput) Healthy() bool { return C.cr_audio_healthy() == 1 }
func (nativeOutput) Stop() error {
	if C.cr_audio_stop() != 1 {
		return errors.New("AUDIO_RECOVERY_PENDING")
	}
	return nil
}

// RunNative is admitted only by the companion's direct owner/private-pipe
// checks. The deadline also applies while Core Audio or the output pipe stalls.
func RunNative(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c := New(nativeOutput{}, time.Now)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		for {
			var timer *time.Timer
			var expiry <-chan time.Time
			if deadline := c.Deadline(); !deadline.IsZero() {
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
			case <-c.Withdrawn():
				withdrawn = true
			case <-c.DeadlineChanged():
			case <-expiry:
				deadline := c.Deadline()
				if !deadline.IsZero() && !time.Now().Before(deadline) {
					withdrawn = true
					cancel()
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
					os.Exit(3)
				}
			}
		}
	}()
	return Serve(ctx, input, output, c)
}
