package inputfocus

import (
	"encoding/json"
	"os"
	"strconv"
)

func configureManagedClipboard(worker *probe, stateDirectory string) (func(string) (json.RawMessage, error), error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	worker.executable = executable
	worker.observeExit = true
	worker.arguments = []string{"--managed-clipboard", "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", stateDirectory}
	return worker.read, nil
}
