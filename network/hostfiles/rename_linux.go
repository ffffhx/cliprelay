package hostfiles

import "golang.org/x/sys/unix"

func renameExclusive(from *directory, source string, to *directory, target string) error {
	return unix.Renameat2(from.fd(), source, to.fd(), target, unix.RENAME_NOREPLACE)
}
