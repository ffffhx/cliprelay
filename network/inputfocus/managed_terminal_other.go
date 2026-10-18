//go:build !darwin

package inputfocus

func configureManagedTerminal(worker *probe, stateDirectory string) error { return nil }
