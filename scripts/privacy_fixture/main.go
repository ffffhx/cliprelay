// Disposable CI harness for the private worker library, never a shipped entry.
package main

import (
	"cliprelay/network/hostprivacy"
	"context"
	"os"
	"runtime"
	"time"
)

func init() { runtime.LockOSThread() }
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
	if hostprivacy.RunNative(ctx, os.Stdin, os.Stdout) != nil {
		os.Exit(1)
	}
}
