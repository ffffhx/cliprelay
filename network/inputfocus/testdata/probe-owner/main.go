// A disposable line-protocol worker for process ownership tests. It has no
// desktop, clipboard, network or native permission integrations.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--herdr-probe" {
		herdrFixture()
		return
	}
	if len(os.Args) != 2 || (os.Args[1] != "--focus-probe" && os.Args[1] != "--voice-probe") {
		os.Exit(2)
	}
	if marker := os.Getenv("CLIPRELAY_PROBE_FIXTURE_STARTED"); marker != "" {
		if os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600) != nil {
			os.Exit(3)
		}
	}
	defer func() {
		if marker := os.Getenv("CLIPRELAY_PROBE_FIXTURE_EXITED"); marker != "" {
			_ = os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600)
		}
	}()
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
		if command == "reply-exit" {
			return
		}
	}
	if ignoreEOF {
		time.Sleep(time.Hour)
	}
}

func herdrFixture() {
	journal, err := os.OpenFile(os.Getenv("CLIPRELAY_HERDR_FIXTURE_JOURNAL"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(3)
	}
	defer journal.Close()
	scanner := bufio.NewScanner(os.Stdin)
	out, log := json.NewEncoder(os.Stdout), json.NewEncoder(journal)
	for scanner.Scan() {
		var request map[string]any
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(4)
		}
		if log.Encode(request) != nil {
			os.Exit(5)
		}
		reply := map[string]any{"ok": true, "instance": "0123456789abcdef0123456789abcdef"}
		if request["op"] == "list" {
			reply["result"] = map[string]any{"owner": request["owner"], "terminals": []any{map[string]any{"address": "t1", "name": "herdr fixture", "state": "live"}}}
		} else if request["op"] != "sync" {
			os.Exit(6)
		}
		if out.Encode(reply) != nil {
			os.Exit(7)
		}
	}
}
