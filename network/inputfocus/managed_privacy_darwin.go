package inputfocus

import (
	"context"
	"os"
	"strconv"
	"time"
)

func configureManagedPrivacy(parent context.Context, control *privacyControl, stateDirectory string, access EngineAccess) (func(), error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	broker := &managedPrivacy{parent: parent, now: time.Now, engine: enginePrivacyProviderWithAccess(access),
		create: func() (privacyOwnedWorker, error) {
			return &privacyProcess{probe: &probe{ctx: parent, executable: executable, stderr: os.Stderr, observeExit: true, noRestart: true, maxOutput: 8192, timeout: 3 * time.Second,
				arguments: []string{"--managed-privacy", "--owner-pid", strconv.Itoa(os.Getpid()), "--state-dir", stateDirectory}}}, nil
		}}
	control.managed = broker.handle
	return broker.close, nil
}
