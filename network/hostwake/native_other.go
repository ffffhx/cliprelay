//go:build !darwin || !cgo

package hostwake

import "errors"

func Read() (Inventory, error) { return Inventory{}, errors.New("WAKE_UNAVAILABLE") }
