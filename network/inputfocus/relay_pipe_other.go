//go:build !windows

package inputfocus

import (
	"net"
	"os"
	"path/filepath"
)

func relayPipe(dir string) (net.Listener, error) {
	listener, err := net.Listen("unix", filepath.Join(dir, "clipboard-relay.sock"))
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(filepath.Join(dir, "clipboard-relay.sock"), 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}
