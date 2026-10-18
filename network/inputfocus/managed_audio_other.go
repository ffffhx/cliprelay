//go:build !darwin

package inputfocus

func configureManagedAudio(worker *probe, stateDirectory string) error { return nil }
