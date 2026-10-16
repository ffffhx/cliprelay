package main

import (
	"os"
	"os/exec"
	"strconv"

	"cliprelay/network/hostterminal"
)

func managedTerminalFactory(directory string) (hostterminal.Factory, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return func(shell string, columns, rows int, output func([]byte)) (hostterminal.Process, error) {
		command := exec.Command(executable, "--terminal-session", shell, "--terminal-columns", strconv.Itoa(columns), "--terminal-rows", strconv.Itoa(rows), "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", directory)
		return hostterminal.StartGuarded(command, output)
	}, nil
}
