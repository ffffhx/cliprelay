//go:build darwin && cgo

package hostclipboard

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -fobjc-arc
#cgo LDFLAGS: -mmacosx-version-min=12.0 -framework AppKit -framework ImageIO -framework ApplicationServices
#include <stdlib.h>
#include "native_darwin.h"
*/
import "C"

import (
	"encoding/base64"
	"errors"
	"unsafe"
)

// An unnamed board is always the system pasteboard. Named boards are used only
// by in-package native tests; neither the worker nor its network API accepts one.
type nativeAccess struct{ name string }

func NewNative() Access { return nativeAccess{} }

func nativeError(code C.int) error {
	switch code {
	case 0:
		return nil
	case 1:
		return errors.New("CLIPBOARD_EMPTY")
	case 2:
		return errors.New("CLIPBOARD_LOCKED")
	case 3:
		return errors.New("CLIPBOARD_TOO_LARGE")
	case 5:
		return errors.New("CLIPBOARD_PERMISSION_REQUIRED")
	default:
		return errors.New("CLIPBOARD_UNAVAILABLE")
	}
}

func (nativeAccess) Available() error { return nativeError(C.cr_clipboard_available()) }

func (a nativeAccess) Read() (Payload, error) {
	name := C.CString(a.name)
	defer C.free(unsafe.Pointer(name))
	var kind C.int
	var data unsafe.Pointer
	var length C.size_t
	code := C.cr_clipboard_read(name, &kind, &data, &length)
	if data != nil {
		defer C.free(data)
	}
	if err := nativeError(code); err != nil {
		return Payload{}, err
	}
	if length > ImageLimit || data == nil {
		return Payload{}, errors.New("CLIPBOARD_TOO_LARGE")
	}
	raw := C.GoBytes(data, C.int(length))
	switch kind {
	case 1:
		return Payload{Kind: "text", Text: string(raw)}, nil
	case 2:
		return Payload{Kind: "png", Data: base64.StdEncoding.EncodeToString(raw)}, nil
	default:
		return Payload{}, errors.New("CLIPBOARD_UNAVAILABLE")
	}
}

func (a nativeAccess) Write(value Payload) error {
	if err := validate(value); err != nil {
		return err
	}
	raw, kind := []byte(value.Text), C.int(1)
	if value.Kind == "png" {
		raw, _ = base64.StdEncoding.Strict().DecodeString(value.Data)
		kind = 2
	}
	name := C.CString(a.name)
	defer C.free(unsafe.Pointer(name))
	return nativeError(C.cr_clipboard_write(name, kind, unsafe.Pointer(&raw[0]), C.size_t(len(raw))))
}
