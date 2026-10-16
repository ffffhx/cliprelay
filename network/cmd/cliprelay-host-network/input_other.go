//go:build !darwin && !linux

package main

import "os"

func ownedInput(*os.File) bool { return false }
