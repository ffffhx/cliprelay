package main

import "os"

func ownedInput(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeNamedPipe != 0
}
