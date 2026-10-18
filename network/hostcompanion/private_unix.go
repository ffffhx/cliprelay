//go:build darwin || linux

package hostcompanion

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func privateInfo(path string, directory bool) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, errors.New("HOST_STATE_INVALID")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	mode := os.FileMode(0600)
	if directory {
		mode = 0700
	}
	if !ok || int(stat.Uid) != os.Getuid() || info.Mode().Perm() != mode || info.Mode()&(os.ModeSymlink|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 ||
		(directory && !info.IsDir()) || (!directory && (!info.Mode().IsRegular() || stat.Nlink != 1)) {
		return nil, errors.New("HOST_STATE_INVALID")
	}
	return info, nil
}

func validateState(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("HOST_STATE_INVALID")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return errors.New("HOST_STATE_INVALID")
	}
	if _, err := privateInfo(path, true); err != nil {
		return err
	}
	count := 0
	return filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return errors.New("HOST_STATE_INVALID")
		}
		count++
		relative, _ := filepath.Rel(path, current)
		if count > 10000 || strings.Count(relative, string(filepath.Separator)) > 16 {
			return errors.New("HOST_STATE_INVALID")
		}
		_, err := privateInfo(current, entry.IsDir())
		return err
	})
}

type runtimeDirectory struct {
	path   string
	anchor os.FileInfo
}

func newRuntime() (*runtimeDirectory, error) {
	// macOS's per-user TMPDIR is often too long for a Unix-domain socket.
	// MkdirTemp creates an unpredictable private directory; never reuse a name.
	path, err := os.MkdirTemp("/tmp", "cliprelay-host-")
	if err != nil {
		return nil, errors.New("HOST_RUNTIME_UNAVAILABLE")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		_ = os.Remove(path)
		return nil, errors.New("HOST_RUNTIME_UNAVAILABLE")
	}
	info, err := privateInfo(resolved, true)
	if err != nil {
		_ = os.Remove(path)
		return nil, errors.New("HOST_RUNTIME_UNAVAILABLE")
	}
	return &runtimeDirectory{resolved, info}, nil
}

func (runtime *runtimeDirectory) close() error {
	info, err := privateInfo(runtime.path, true)
	if err != nil || !os.SameFile(runtime.anchor, info) {
		return errors.New("HOST_RUNTIME_CHANGED")
	}
	// The joined Unix listener removes its own socket. Never recursively remove
	// unexpected files or follow a replaced runtime directory during teardown.
	if err := os.Remove(runtime.path); err != nil {
		return errors.New("HOST_RUNTIME_CLEANUP_FAILED")
	}
	return nil
}
