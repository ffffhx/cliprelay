//go:build darwin || linux

package main

import (
	"golang.org/x/sys/unix"
	"os"
	"testing"
	"time"
)

func TestHostCompanionInheritedInputBoundary(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	if !ownedInput(read) || ownedInput(write) {
		t.Fatal("pipe direction not checked")
	}
	file, err := os.CreateTemp(t.TempDir(), "not-a-pipe")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if ownedInput(file) {
		t.Fatal("regular file admitted")
	}
	for _, kind := range []int{unix.SOCK_STREAM, unix.SOCK_DGRAM} {
		pair, err := unix.Socketpair(unix.AF_UNIX, kind, 0)
		if err != nil {
			t.Fatal(err)
		}
		file := os.NewFile(uintptr(pair[0]), "inherited-pair")
		allowed := ownedInput(file)
		file.Close()
		unix.Close(pair[1])
		if allowed != (kind == unix.SOCK_STREAM) {
			t.Fatal("socket kind not checked")
		}
	}
	for _, family := range []int{unix.AF_UNIX, unix.AF_INET} {
		fd, err := unix.Socket(family, unix.SOCK_STREAM, 0)
		if err != nil {
			t.Fatal(err)
		}
		file := os.NewFile(uintptr(fd), "unconnected")
		allowed := ownedInput(file)
		file.Close()
		if allowed {
			t.Fatal("unconnected or network socket admitted")
		}
	}
}

func TestHostCompanionInheritedReadCanBeCancelledWithWriterHeld(t *testing.T) {
	read, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer writer.Close()
	input, err := pollableChannel(read, true)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { _, err := input.Read(make([]byte, 1)); finished <- err }()
	closed := make(chan struct{})
	go func() { input.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close retained blocking inherited read")
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("closed read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("inherited reader survived close")
	}
	if !ownedOutput(writer) || ownedOutput(read) {
		t.Fatal("output direction not checked")
	}
}
