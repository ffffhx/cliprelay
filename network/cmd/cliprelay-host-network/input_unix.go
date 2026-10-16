//go:build darwin || linux

package main

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"time"
)

func ownedInput(file *os.File) bool {
	return ownedChannel(file, true)
}

func ownedOutput(file *os.File) bool {
	return ownedChannel(file, false)
}

func ownedChannel(file *os.File, reading bool) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFL, 0)
	if err != nil || (reading && flags&unix.O_ACCMODE == unix.O_WRONLY) || (!reading && flags&unix.O_ACCMODE == unix.O_RDONLY) {
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

// os.Stdin/os.Stdout may wrap blocking inherited descriptors. Closing those
// original os.Files cannot reliably interrupt a blocked syscall. Duplicate them
// with O_NONBLOCK before NewFile so Go registers each channel with its poller.
// Do not call Fd on the returned file: Fd can switch it back to blocking mode.
func pollableChannel(file *os.File, reading bool) (*os.File, error) {
	if !ownedChannel(file, reading) {
		return nil, errors.New("HOST_OWNER_INVALID")
	}
	fd, err := unix.FcntlInt(file.Fd(), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return nil, errors.New("HOST_CHANNEL_UNAVAILABLE")
	}
	if unix.SetNonblock(fd, true) != nil {
		unix.Close(fd)
		return nil, errors.New("HOST_CHANNEL_UNAVAILABLE")
	}
	channel := os.NewFile(uintptr(fd), "owned-host-channel")
	if reading {
		err = channel.SetReadDeadline(time.Time{})
	} else {
		err = channel.SetWriteDeadline(time.Time{})
	}
	if err != nil {
		channel.Close()
		return nil, errors.New("HOST_CHANNEL_UNAVAILABLE")
	}
	return channel, nil
}
