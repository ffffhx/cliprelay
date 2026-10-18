//go:build !darwin || !cgo

package hostprivacy

import (
	"context"
	"errors"
	"io"
)

func RunNative(context.Context, io.ReadCloser, io.WriteCloser) error {
	return errors.New("PRIVACY_UNSUPPORTED")
}
