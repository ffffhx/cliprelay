// This is an application-owned Mac host companion, never the Windows service.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"cliprelay/network/hostcompanion"
	"cliprelay/network/inputfocus"
)

func main() {
	flags := flag.NewFlagSet("cliprelay-host-network", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("state-dir", "", "private prepared engine state directory")
	owner := flags.Int("owner-pid", 0, "direct owning application PID")
	if flags.Parse(os.Args[1:]) != nil || flags.NArg() != 0 || runtime.GOOS != "darwin" || *owner <= 1 || *owner != os.Getppid() ||
		!filepath.IsAbs(*directory) || !ownedInput(os.Stdin) || !ownedOutput(os.Stdout) {
		fmt.Fprintln(os.Stderr, "HOST_OWNER_INVALID")
		os.Exit(2)
	}
	input, inputErr := pollableChannel(os.Stdin, true)
	output, outputErr := pollableChannel(os.Stdout, false)
	if inputErr != nil || outputErr != nil {
		if input != nil {
			input.Close()
		}
		if output != nil {
			output.Close()
		}
		fmt.Fprintln(os.Stderr, "HOST_CHANNEL_UNAVAILABLE")
		os.Exit(2)
	}
	_ = os.Stdin.Close()
	_ = os.Stdout.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// EOF alone is insufficient if another descendant inherited the
				// writing end. Reparenting also withdraws this owner's authority.
				if os.Getppid() != *owner {
					cancel()
					return
				}
			}
		}
	}()
	err := hostcompanion.Run(ctx, input, output, *directory, *owner, inputfocus.ServeManagedHost)
	cancel()
	<-watchDone
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
