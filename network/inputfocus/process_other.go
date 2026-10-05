//go:build !windows

package inputfocus

import "os/exec"

func quietProcess(cmd *exec.Cmd) {}
