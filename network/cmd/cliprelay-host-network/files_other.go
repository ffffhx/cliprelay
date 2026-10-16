//go:build !darwin && !linux

package main

import (
	"context"
	"errors"
	"io"
)

func runManagedFiles(ctx context.Context, input io.ReadCloser, output io.WriteCloser, stateDirectory string) error {
	return errors.New("FILES_UNAVAILABLE")
}
