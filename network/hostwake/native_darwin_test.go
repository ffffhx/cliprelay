//go:build darwin && cgo

package hostwake

import (
	"testing"
)

func TestWakeNativeInventoryReadOnly(t *testing.T) {
	first, err := Read()
	if err != nil || !first.OK || !first.Supported || first.Platform != "macos" || first.WakeVerified {
		t.Fatal(first, err)
	}
	if len(first.Adapters) == 0 {
		t.Fatal("native fixture requires a system Ethernet or Wi-Fi interface")
	}
	for _, a := range first.Adapters {
		if a.Configuration != "unknown" || a.MagicPacket != "unknown" || a.PowerManagement != "unknown" || a.WakeArmed != "unknown" {
			t.Fatal("invented hardware support", a)
		}
	}
	t.Logf("native adapters=%d; no power changes or UDP sends", len(first.Adapters))
}
