//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func ownedInput(file *os.File) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	if info.Mode()&os.ModeNamedPipe != 0 {
		return true
	}
	if info.Mode()&os.ModeSocket == 0 {
		return false
	}
	// Node/libuv uses a connected Unix stream socket pair for child stdio.
	// Accept this inherited pipe equivalent, never a file, terminal, network
	// socket, datagram socket or listening Unix socket.
	fd := int(file.Fd())
	local, err := unix.Getsockname(fd)
	if err != nil {
		return false
	}
	if _, ok := local.(*unix.SockaddrUnix); !ok {
		return false
	}
	peer, err := unix.Getpeername(fd)
	if err != nil {
		return false
	}
	if _, ok := peer.(*unix.SockaddrUnix); !ok {
		return false
	}
	kind, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
	return err == nil && kind == unix.SOCK_STREAM
}
