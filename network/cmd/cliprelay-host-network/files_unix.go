//go:build darwin || linux

package main

import (
	"cliprelay/network/hostfiles"
	"context"
	"io"
)

func runManagedFiles(ctx context.Context, input io.ReadCloser, output io.WriteCloser, stateDirectory string) error {
	return hostfiles.ServeDefault(ctx, input, output, stateDirectory)
}
