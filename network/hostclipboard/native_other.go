//go:build !darwin || !cgo

package hostclipboard

import "errors"

type unavailable struct{}

func NewNative() Access                    { return unavailable{} }
func (unavailable) Available() error       { return errors.New("CLIPBOARD_UNAVAILABLE") }
func (unavailable) Read() (Payload, error) { return Payload{}, errors.New("CLIPBOARD_UNAVAILABLE") }
func (unavailable) Write(Payload) error    { return errors.New("CLIPBOARD_UNAVAILABLE") }
