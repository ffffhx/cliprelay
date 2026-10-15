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
	if flag.NArg() != 0 || !filepath.IsAbs(*directory) || !ownedInput(os.Stdin) {
		os.Exit(2)
	}
	if err := desktopclient.Run(context.Background(), os.Stdin, os.Stdout, desktopclient.FactoryForDirectory(*directory)); err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "error", "code": err.Error()})
		os.Exit(1)
	}
}
