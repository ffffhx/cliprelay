// Package hostwake provides read-only Mac LAN inventory. Sending remains in the
// paired host API, which owns authorization, routes, rate limits and receipts.
package hostwake

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"strings"
)

type Address struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
}
type Adapter struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Kind            string    `json:"kind"`
	MAC             string    `json:"mac"`
	Connected       bool      `json:"connected"`
	Addresses       []Address `json:"addresses"`
	MagicPacket     string    `json:"magicPacket"`
	PowerManagement string    `json:"powerManagement"`
	WakeArmed       string    `json:"wakeArmed"`
	Configuration   string    `json:"configuration"`
}
type Inventory struct {
	OK           bool      `json:"ok"`
	Supported    bool      `json:"supported"`
	Platform     string    `json:"platform"`
	Adapters     []Adapter `json:"adapters"`
	WakeVerified bool      `json:"wakeVerified"`
}
type nativeInterface struct{ BSD, Name, Kind, MAC string }
type interfaceState struct {
	MAC       net.HardwareAddr
	Flags     net.Flags
	Addresses []net.Addr
}

var bsdName = regexp.MustCompile(`^en[0-9]{1,4}$`)

func systemInterface(name string) (interfaceState, error) {
	item, err := net.InterfaceByName(name)
	if err != nil {
		return interfaceState{}, err
	}
	addresses, err := item.Addrs()
	return interfaceState{item.HardwareAddr, item.Flags, addresses}, err
}

func inventory(interfaces []nativeInterface, lookup func(string) (interfaceState, error)) (Inventory, error) {
	value := Inventory{OK: true, Supported: true, Platform: "macos", Adapters: []Adapter{}}
	seen := make(map[string]bool)
	for _, item := range interfaces {
		// SC types exclude VPN, bridge, VLAN and bond interfaces; the BSD name
		// check additionally excludes peer-to-peer Wi-Fi and software adapters.
		if !bsdName.MatchString(item.BSD) || seen[item.BSD] || (item.Kind != "ethernet" && item.Kind != "wifi") {
			continue
		}
		seen[item.BSD] = true
		mac, err := net.ParseMAC(item.MAC)
		if err != nil || len(mac) != 6 || mac[0]&1 != 0 || bytes.Equal(mac, make([]byte, 6)) {
			continue
		}
		state, err := lookup(item.BSD)
		// Cross-check independent OS snapshots; never use a renamed/replaced
		// interface or carry old addresses through a failed enumeration.
		if err != nil || mac.String() != state.MAC.String() || state.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		name := item.Name
		if name == "" || len([]rune(name)) > 128 || len(name) > 512 || strings.ContainsAny(name, "\x00\r\n") {
			name = item.BSD
		}
		macText := strings.ToUpper(mac.String())
		// Opaque protocol ID, not a Windows device GUID. Include both identity
		// observations so hardware replacement invalidates saved selections.
		digest := sha256.Sum256([]byte("cliprelay-macos-wake-v1\x00" + item.BSD + "\x00" + macText))
		id := fmt.Sprintf("%x-%x-%x-%x-%x", digest[:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
		a := Adapter{ID: id, Name: name, Kind: item.Kind, MAC: macText, Addresses: []Address{},
			Connected:   state.Flags&(net.FlagUp|net.FlagRunning|net.FlagBroadcast) == net.FlagUp|net.FlagRunning|net.FlagBroadcast,
			MagicPacket: "unknown", PowerManagement: "unknown", WakeArmed: "unknown", Configuration: "unknown"}
		// macOS network-service availability is not per-adapter wake arming.
		// Public interface APIs cannot establish those hardware facts. A global
		// power preference must never turn these observations into "configured".
		addresses := make(map[string]bool)
		for _, raw := range state.Addresses {
			prefix, err := netip.ParsePrefix(raw.String())
			if err != nil || !prefix.Addr().Is4() || prefix.Bits() < 1 || prefix.Bits() > 32 {
				continue
			}
			ip := prefix.Addr()
			bytes := ip.As4()
			if bytes[0] == 0 || bytes[0] == 127 || bytes[0] >= 224 || addresses[prefix.String()] {
				continue
			}
			addresses[prefix.String()] = true
			a.Addresses = append(a.Addresses, Address{ip.String(), prefix.Bits()})
		}
		if len(a.Addresses) > 8 || len(value.Adapters) >= 32 {
			return Inventory{}, errors.New("WAKE_UNAVAILABLE")
		}
		sort.Slice(a.Addresses, func(i, j int) bool { return a.Addresses[i].Address < a.Addresses[j].Address })
		value.Adapters = append(value.Adapters, a)
	}
	sort.Slice(value.Adapters, func(i, j int) bool { return value.Adapters[i].ID < value.Adapters[j].ID })
	return value, nil
}
