//go:build !darwin && !linux

package main

import (
	"errors"
	"os"
)

func ownedInput(*os.File) bool  { return false }
func ownedOutput(*os.File) bool { return false }
func pollableChannel(*os.File, bool) (*os.File, error) {
	return nil, errors.New("HOST_PLATFORM_UNSUPPORTED")
}
