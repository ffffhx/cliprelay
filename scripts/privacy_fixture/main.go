// Disposable CI harness for the private worker library, never a shipped entry.
package main

import (
	"cliprelay/network/hostprivacy"
	"context"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"runtime"
	"time"
)

func init() { runtime.LockOSThread() }
func channel(file *os.File) *os.File {
	// Match the production CLI: inherited blocking descriptors need a fresh
	// nonblocking wrapper for cancellation and output write deadlines.
	fd, err := unix.FcntlInt(file.Fd(), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		panic(err)
	}
	if err = unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		panic(err)
	}
	result := os.NewFile(uintptr(fd), "privacy-fixture-channel")
	file.Close()
	return result
}
func main() {
	if os.Getenv("GITHUB_ACTIONS") != "true" || runtime.GOOS != "darwin" {
		os.Exit(2)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	parent := os.Getppid()
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != parent {
					cancel()
					return
				}
			}
		}
	}()
	if err := hostprivacy.RunNative(ctx, channel(os.Stdin), channel(os.Stdout)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
