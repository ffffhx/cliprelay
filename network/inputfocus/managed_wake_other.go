//go:build !darwin

package inputfocus

func configureManagedWake(worker *probe, stateDirectory string) error { return nil }
