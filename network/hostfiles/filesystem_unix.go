//go:build darwin || linux

package hostfiles

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Every child traversal is relative to an already opened directory. No request
// path is passed to a path-based open, rename, unlink or directory creation.
type directory struct {
	file *os.File
	key  fileKey
}

func directoryFD(fd int) (*directory, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		unix.Close(fd)
		return nil, fail("BAD_PATH")
	}
	return &directory{os.NewFile(uintptr(fd), "host-file-directory"), identity(&st)}, nil
}
func openDirectory(path string) (*directory, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, fail("BAD_PATH")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	current, err := directoryFD(fd)
	if err != nil {
		return nil, err
	}
	if path == "/" {
		return current, nil
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, err := current.child(part)
		current.close()
		if err != nil {
			return nil, err
		}
		current = next
	}
	return current, nil
}
func (d *directory) fd() int { return int(d.file.Fd()) }
func (d *directory) close()  { _ = d.file.Close() }
func (d *directory) child(name string) (*directory, error) {
	fd, err := unix.Openat(d.fd(), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		st, statErr := d.stat(name)
		if statErr == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return nil, fail("LINK_NOT_ALLOWED")
		}
		return nil, err
	}
	return directoryFD(fd)
}
func (d *directory) walk(path string, blocked map[fileKey]bool) (*directory, error) {
	if !safePath(path) {
		return nil, fail("BAD_PATH")
	}
	current, err := d.child(".")
	if err != nil {
		return nil, err
	}
	if blocked[current.key] {
		current.close()
		return nil, fail("BAD_PATH")
	}
	if path == "" {
		return current, nil
	}
	for _, part := range strings.Split(path, "/") {
		next, err := current.child(part)
		current.close()
		if err != nil {
			return nil, err
		}
		if next.key.Device != d.key.Device || blocked[next.key] {
			next.close()
			return nil, fail("BAD_PATH")
		}
		current = next
	}
	return current, nil
}
func (d *directory) private() error {
	var st unix.Stat_t
	if err := unix.Fstat(d.fd(), &st); err != nil {
		return err
	}
	if int(st.Uid) != os.Getuid() || st.Mode&07777 != 0700 {
		return fail("ACCESS_DENIED")
	}
	return nil
}
func (d *directory) privateChild(name string) (*directory, error) {
	if err := unix.Mkdirat(d.fd(), name, 0700); err != nil && !errors.Is(err, unix.EEXIST) {
		return nil, err
	}
	child, err := d.child(name)
	if err != nil {
		return nil, err
	}
	if err = child.private(); err != nil {
		child.close()
		return nil, err
	}
	return child, nil
}
func (d *directory) regular(name string, flags int, private bool) (*os.File, unix.Stat_t, error) {
	var st unix.Stat_t
	fd, err := unix.Openat(d.fd(), name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, st, err
	}
	if err = unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, st, err
	}
	// Refuse devices, FIFOs, sockets, links and filesystem crossings before I/O.
	// Private files are also required to retain their owner and mode.
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || uint64(st.Dev) != d.key.Device ||
		(private && (int(st.Uid) != os.Getuid() || st.Mode&07777 != 0600)) {
		unix.Close(fd)
		return nil, st, fail("LINK_NOT_ALLOWED")
	}
	return os.NewFile(uintptr(fd), "host-transfer-file"), st, nil
}
func (d *directory) stat(name string) (unix.Stat_t, error) {
	var st unix.Stat_t
	err := unix.Fstatat(d.fd(), name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return st, err
}
func (d *directory) space(required uint64) error {
	var st unix.Statfs_t
	if err := unix.Fstatfs(d.fd(), &st); err != nil {
		return err
	}
	if st.Bsize <= 0 {
		return fail("IO")
	}
	// Division avoids overflowing the multiplication for unusually large volumes.
	blocks := (required + reserveBytes + uint64(st.Bsize) - 1) / uint64(st.Bsize)
	if uint64(st.Bavail) < blocks {
		return fail("DISK_FULL")
	}
	return nil
}
func (d *directory) unlink(name string, key fileKey) error {
	st, err := d.stat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || identity(&st) != key || st.Nlink != 1 {
		return fail("INVALID_STATE")
	}
	return unix.Unlinkat(d.fd(), name, 0)
}
func (d *directory) sync() error { return d.file.Sync() }
