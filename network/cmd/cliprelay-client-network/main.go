// This is an owned controller helper, never a system service or a general proxy.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"

	"cliprelay/network/desktopclient"
)

func main() {
	directory := flag.String("state-dir", "", "private persistent node directory")
	flag.Parse()
	info, err := os.Stdin.Stat()
	if flag.NArg() != 0 || !filepath.IsAbs(*directory) || err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		os.Exit(2)
	}
	if err := desktopclient.Run(context.Background(), os.Stdin, os.Stdout, desktopclient.FactoryForDirectory(*directory)); err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "error", "code": err.Error()})
		os.Exit(1)
	}
}
