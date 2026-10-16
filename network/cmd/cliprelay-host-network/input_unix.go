//go:build darwin || linux

package main

import (
	"golang.org/x/sys/unix"
	"os"
)

func ownedInput(file *os.File) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_ACCMODE == unix.O_WRONLY {
		return false
	}
	if info.Mode()&os.ModeNamedPipe != 0 {
		return true
	}
	if info.Mode()&os.ModeSocket == 0 {
		return false
	}
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
