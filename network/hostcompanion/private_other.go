//go:build !darwin && !linux

package hostcompanion

import "errors"

type runtimeDirectory struct{ path string }

func validateState(string) error             { return errors.New("HOST_PLATFORM_UNSUPPORTED") }
func newRuntime() (*runtimeDirectory, error) { return nil, errors.New("HOST_PLATFORM_UNSUPPORTED") }
func (*runtimeDirectory) close() error       { return errors.New("HOST_PLATFORM_UNSUPPORTED") }
