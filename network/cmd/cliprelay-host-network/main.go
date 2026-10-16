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

	"cliprelay/network/hostclipboard"
	"cliprelay/network/hostcompanion"
	"cliprelay/network/inputfocus"
)

func main() {
	flags := flag.NewFlagSet("cliprelay-host-network", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("state-dir", "", "private prepared engine state directory")
	owner := flags.Int("owner-pid", 0, "direct owning application PID")
	managedFiles := flags.Bool("managed-files", false, "owned native file worker")
	managedClipboard := flags.Bool("managed-clipboard", false, "owned native clipboard worker")
	if flags.Parse(os.Args[1:]) != nil || flags.NArg() != 0 || runtime.GOOS != "darwin" || *owner <= 1 || *owner != os.Getppid() ||
		(*managedFiles && *managedClipboard) || !filepath.IsAbs(*directory) || !ownedInput(os.Stdin) || !ownedOutput(os.Stdout) {
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
	workerDone := make(chan struct{})
	guardianDone := make(chan struct{})
	if *managedFiles || *managedClipboard {
		// A killed companion cannot supervise its worker any more. EOF or the
		// parent watcher still withdraws access; bound even a stuck filesystem
		// shutdown instead of retaining an orphan after the parent disappears.
		go func() {
			defer close(guardianDone)
			select {
			case <-ctx.Done():
			case <-workerDone:
				return
			}
			timer := time.NewTimer(5 * time.Second)
			defer timer.Stop()
			select {
			case <-workerDone:
			case <-timer.C:
				os.Exit(2)
			}
		}()
	} else {
		close(guardianDone)
	}
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
	var err error
	if *managedFiles {
		err = runManagedFiles(ctx, input, output, *directory)
	} else if *managedClipboard {
		runtime.LockOSThread()
		err = hostclipboard.Serve(ctx, input, output, hostclipboard.NewNative())
		runtime.UnlockOSThread()
	} else {
		err = hostcompanion.Run(ctx, input, output, *directory, *owner, inputfocus.ServeManagedHost)
	}
	cancel()
	<-watchDone
	close(workerDone)
	<-guardianDone
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
