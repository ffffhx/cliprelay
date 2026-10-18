package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOwnedInputPipeAndFileBoundary(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	if !ownedInput(reader) {
		t.Fatal("anonymous parent pipe rejected")
	}
	for _, name := range []string{filepath.Join(t.TempDir(), "credential-file"), os.DevNull} {
		file, err := os.OpenFile(name, os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			t.Fatal(err)
		}
		allowed := ownedInput(file)
		file.Close()
		if allowed {
			t.Fatal("non-pipe input accepted")
		}
	}
}
