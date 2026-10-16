//go:build !darwin

package inputfocus

func configureManagedFiles(worker *probe, stateDirectory string) error { return nil }
