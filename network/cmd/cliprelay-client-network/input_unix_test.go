//go:build !windows

package main

import (
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOwnedInputUnixSocketBoundary(t *testing.T) {
	for _, kind := range []int{unix.SOCK_STREAM, unix.SOCK_DGRAM} {
		pair, err := unix.Socketpair(unix.AF_UNIX, kind, 0)
		if err != nil {
			t.Fatal(err)
		}
		file := os.NewFile(uintptr(pair[0]), "inherited-local-socket")
		allowed := ownedInput(file)
		file.Close()
		unix.Close(pair[1])
		if allowed != (kind == unix.SOCK_STREAM) {
			t.Fatal("incorrect local socket type accepted")
		}
	}
	for _, family := range []int{unix.AF_UNIX, unix.AF_INET} {
		fd, err := unix.Socket(family, unix.SOCK_STREAM, 0)
		if err != nil {
			t.Fatal(err)
		}
		file := os.NewFile(uintptr(fd), "unconnected-or-network-socket")
		allowed := ownedInput(file)
		file.Close()
		if allowed {
			t.Fatal("non-pair socket accepted")
		}
	}
}
