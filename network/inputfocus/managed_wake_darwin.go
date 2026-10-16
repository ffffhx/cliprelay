package inputfocus

import (
	"os"
	"strconv"
)

func configureManagedWake(worker *probe, stateDirectory string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	worker.executable = executable
	worker.observeExit = true
	worker.arguments = []string{"--managed-wake", "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", stateDirectory}
	return nil
}
