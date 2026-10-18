//go:build darwin && cgo

package hostwake

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -fobjc-arc
#cgo LDFLAGS: -mmacosx-version-min=12.0 -framework Foundation -framework SystemConfiguration
#include <stdlib.h>
#include "native_darwin.h"
*/
import "C"
import (
	"encoding/json"
	"errors"
	"unsafe"
)

func Read() (Inventory, error) {
	raw := C.cr_wake_interfaces()
	if raw == nil {
		return Inventory{}, errors.New("WAKE_UNAVAILABLE")
	}
	defer C.free(unsafe.Pointer(raw))
	var interfaces []nativeInterface
	if err := json.Unmarshal([]byte(C.GoString(raw)), &interfaces); err != nil {
		return Inventory{}, errors.New("WAKE_UNAVAILABLE")
	}
	return inventory(interfaces, systemInterface)
}
