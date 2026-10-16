//go:build !darwin

package inputfocus

import "encoding/json"

func configureManagedClipboard(worker *probe, stateDirectory string) (func(string) (json.RawMessage, error), error) {
	return nil, nil
}
