// A disposable line-protocol worker for process ownership tests. It has no
// desktop, clipboard, network or native permission integrations.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"time"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "--focus-probe" {
		os.Exit(2)
	}
	scanner := bufio.NewScanner(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	ignoreEOF := false
	for scanner.Scan() {
		command := scanner.Text()
		switch {
		case strings.HasPrefix(command, "wait:"):
			// The marker proves receipt before the parent cancels; this worker
			// intentionally ignores stdin EOF while the command is blocked.
			if os.WriteFile(strings.TrimPrefix(command, "wait:"), []byte("ready"), 0600) != nil {
				os.Exit(3)
			}
			time.Sleep(time.Hour)
		case command == "ignore-eof":
			ignoreEOF = true
		}
		if out.Encode(struct {
			PID     int    `json:"pid"`
			Command string `json:"command"`
		}{os.Getpid(), command}) != nil {
			os.Exit(4)
		}
	}
	if ignoreEOF {
		time.Sleep(time.Hour)
	}
}
