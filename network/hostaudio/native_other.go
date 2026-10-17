//go:build !darwin || !cgo

package hostaudio

import (
	"context"
	"errors"
	"io"
)

func RunNative(context.Context, io.ReadCloser, io.WriteCloser) error {
	return errors.New("AUDIO_UNSUPPORTED")
}
