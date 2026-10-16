package inputfocus

import (
	"os"
	"strconv"
)

func configureManagedFiles(worker *probe, stateDirectory string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	worker.executable = executable
	worker.arguments = []string{"--managed-files", "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", stateDirectory}
	return nil
}
