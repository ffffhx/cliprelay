package inputfocus

import (
	"os"
	"strconv"
)

func configureManagedTerminal(worker *probe, stateDirectory string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	worker.executable = executable
	worker.observeExit = true
	worker.arguments = []string{"--managed-terminal", "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", stateDirectory}
	return nil
}
