//go:build (!darwin && !linux) || !cgo

package hostterminal

import "errors"

func StartNative(shell string, columns, rows int, output func([]byte)) (Process, error) {
	return nil, errors.New("TERMINAL_UNSUPPORTED")
}
