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
	"cliprelay/network/hostprivacy"
	"cliprelay/network/hostterminal"
	"cliprelay/network/hostwake"
	"cliprelay/network/inputfocus"
)

// AppKit requires the initial process thread. Lock before main can migrate;
// modes without an AppKit event loop release this lock after admission.
func init() {
	if runtime.GOOS == "darwin" {
		runtime.LockOSThread()
	}
}

func main() {
	flags := flag.NewFlagSet("cliprelay-host-network", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("state-dir", "", "private prepared engine state directory")
	owner := flags.Int("owner-pid", 0, "direct owning application PID")
	managedFiles := flags.Bool("managed-files", false, "owned native file worker")
	managedClipboard := flags.Bool("managed-clipboard", false, "owned native clipboard worker")
	managedTerminal := flags.Bool("managed-terminal", false, "owned terminal session worker")
	managedWake := flags.Bool("managed-wake", false, "owned read-only LAN inventory worker")
	managedPrivacy := flags.Bool("managed-privacy", false, "owned native privacy mask worker")
	terminalShell := flags.String("terminal-session", "", "owned native terminal guardian")
	terminalColumns := flags.Int("terminal-columns", 0, "owned terminal columns")
	terminalRows := flags.Int("terminal-rows", 0, "owned terminal rows")
	parseErr := flags.Parse(os.Args[1:])
	workers := 0
	for _, enabled := range []bool{*managedFiles, *managedClipboard, *managedTerminal, *managedWake, *managedPrivacy, *terminalShell != ""} {
		if enabled {
			workers++
		}
	}
	terminalValid := *terminalShell == "" && *terminalColumns == 0 && *terminalRows == 0 || (*terminalShell == "bash" || *terminalShell == "zsh") && *terminalColumns >= 20 && *terminalColumns <= 240 && *terminalRows >= 5 && *terminalRows <= 120
	if parseErr != nil || flags.NArg() != 0 || runtime.GOOS != "darwin" || *owner <= 1 || *owner != os.Getppid() ||
		workers > 1 || !terminalValid || !filepath.IsAbs(*directory) || !ownedInput(os.Stdin) || !ownedOutput(os.Stdout) {
		fmt.Fprintln(os.Stderr, "HOST_OWNER_INVALID")
		os.Exit(2)
	}
	if !*managedPrivacy {
		runtime.UnlockOSThread()
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
	if workers > 0 {
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
	if *managedPrivacy {
		err = hostprivacy.RunNative(ctx, input, output)
	} else if *managedFiles {
		err = runManagedFiles(ctx, input, output, *directory)
	} else if *managedClipboard {
		runtime.LockOSThread()
		err = hostclipboard.Serve(ctx, input, output, hostclipboard.NewNative())
		runtime.UnlockOSThread()
	} else if *managedWake {
		err = hostwake.Serve(ctx, input, output, hostwake.Read)
	} else if *managedTerminal {
		var factory hostterminal.Factory
		factory, err = managedTerminalFactory(*directory)
		if err == nil {
			err = hostterminal.Serve(ctx, input, output, factory)
		}
	} else if *terminalShell != "" {
		err = hostterminal.ServeProcess(ctx, input, output, *terminalShell, *terminalColumns, *terminalRows, hostterminal.StartNative)
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
