package hostwake

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func fixtureState() interfaceState {
	mac, _ := net.ParseMAC("02:11:22:33:44:55")
	return interfaceState{mac, net.FlagUp | net.FlagRunning | net.FlagBroadcast, []net.Addr{&net.IPNet{IP: net.ParseIP("192.168.1.5"), Mask: net.CIDRMask(24, 32)}}}
}
func TestWakeInventoryFiltersVirtualAndChangedInterfaces(t *testing.T) {
	items := []nativeInterface{{"en0", "Wi-Fi", "wifi", "02:11:22:33:44:55"}}
	for _, bsd := range []string{"utun0", "awdl0", "llw0", "bridge0", "bond0", "vlan0", "lo0", "vmnet1"} {
		items = append(items, nativeInterface{bsd, bsd, "ethernet", "02:11:22:33:44:55"})
	}
	items = append(items, nativeInterface{"en1", "VPN", "vpn", "02:11:22:33:44:55"}, items[0])
	called := 0
	value, err := inventory(items, func(name string) (interfaceState, error) { called++; return fixtureState(), nil })
	if err != nil || called != 1 || len(value.Adapters) != 1 || value.Platform != "macos" || value.WakeVerified {
		t.Fatal(value, err, called)
	}
	a := value.Adapters[0]
	if !a.Connected || a.Configuration != "unknown" || a.MagicPacket != "unknown" || a.PowerManagement != "unknown" || a.WakeArmed != "unknown" || len(a.Addresses) != 1 {
		t.Fatal(a)
	}
	for _, mode := range []string{"lookup-error", "replacement", "loopback", "point-to-point"} {
		t.Run(mode, func(t *testing.T) {
			value, err := inventory(items[:1], func(string) (interfaceState, error) {
				s := fixtureState()
				switch mode {
				case "lookup-error":
					return s, errors.New("gone")
				case "replacement":
					s.MAC[5]++
				case "loopback":
					s.Flags |= net.FlagLoopback
				case "point-to-point":
					s.Flags |= net.FlagPointToPoint
				}
				return s, nil
			})
			if err != nil || len(value.Adapters) != 0 {
				t.Fatal(value, err)
			}
		})
	}
}
func TestWakeInventoryStableIdentityAndUnknownPower(t *testing.T) {
	item := nativeInterface{"en0", "Ethernet", "ethernet", "02:11:22:33:44:55"}
	read := func(string) (interfaceState, error) { return fixtureState(), nil }
	a, _ := inventory([]nativeInterface{item}, read)
	item.Name = "renamed"
	b, _ := inventory([]nativeInterface{item}, read)
	if a.Adapters[0].ID != b.Adapters[0].ID {
		t.Fatal("display name changed identity")
	}
	item.MAC = "02:11:22:33:44:66"
	c, _ := inventory([]nativeInterface{item}, func(string) (interfaceState, error) {
		s := fixtureState()
		s.MAC[5] = 0x66
		s.Flags &^= net.FlagRunning
		return s, nil
	})
	if c.Adapters[0].ID == a.Adapters[0].ID || c.Adapters[0].Connected {
		t.Fatal("replacement/link state ignored")
	}
	item.Kind = "wifi"
	item.Name = "invalid\nname"
	d, _ := inventory([]nativeInterface{item}, func(string) (interfaceState, error) { s := fixtureState(); s.MAC[5] = 0x66; return s, nil })
	if d.Adapters[0].Name != "en0" || d.Adapters[0].Configuration != "unknown" {
		t.Fatal(d)
	}
}

type closeBuffer struct{ bytes.Buffer }

func (*closeBuffer) Close() error { return nil }
func TestWakeWorkerStrictReadOnlyProtocolAndEOF(t *testing.T) {
	for _, command := range []string{"wake-status\n", "send\n", "wake-status\nextra", strings.Repeat("x", 256) + "\n"} {
		var out closeBuffer
		calls := 0
		err := Serve(context.Background(), io.NopCloser(strings.NewReader(command)), &out, func() (Inventory, error) { calls++; return inventory(nil, nil) })
		if command == "wake-status\n" {
			var value Inventory
			if err != nil || calls != 1 || json.Unmarshal(out.Bytes(), &value) != nil || !value.OK || value.WakeVerified {
				t.Fatal(err, value)
			}
		} else if err == nil {
			t.Fatal("invalid command accepted")
		}
	}
}
func TestWakeWorkerCancellationClosesBlockedChannel(t *testing.T) {
	input, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, input, &closeBuffer{}, func() (Inventory, error) { t.Error("read without request"); return Inventory{}, nil })
	}()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("orphan worker")
	}
}
