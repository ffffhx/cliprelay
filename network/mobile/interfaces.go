package mobile

import (
	"encoding/json"
	"errors"
	"net"
	"runtime"
	"sync/atomic"

	"tailscale.com/net/netmon"
)

type platformInterface struct {
	Index     int      `json:"index"`
	MTU       int      `json:"mtu"`
	Name      string   `json:"name"`
	Flags     int      `json:"flags"`
	Addresses []string `json:"addresses"`
}

var interfaceSnapshot atomic.Pointer[[]netmon.Interface]

func init() {
	// Modern Android disallows Go's netlink enumeration. The app supplies
	// ConnectivityManager/NetworkInterface data instead, before starting tsnet.
	if runtime.GOOS == "android" {
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
			p := interfaceSnapshot.Load()
			if p == nil {
				return nil, errors.New("Android network interfaces not initialized")
			}
			return *p, nil
		})
	}
}

// SetInterfaces replaces the Java-provided interface snapshot without racing
// tsnet's network monitor. Addresses use IP/prefix-length notation.
func SetInterfaces(value string) error {
	var source []platformInterface
	if err := json.Unmarshal([]byte(value), &source); err != nil {
		return err
	}
	if len(source) > 128 {
		return errors.New("too many interfaces")
	}
	result := make([]netmon.Interface, 0, len(source))
	for _, v := range source {
		if v.Index <= 0 || v.MTU < 1 || v.Name == "" {
			return errors.New("invalid interface")
		}
		addrs := make([]net.Addr, 0, len(v.Addresses))
		for _, a := range v.Addresses {
			ip, prefix, err := net.ParseCIDR(a)
			if err != nil {
				return err
			}
			prefix.IP = ip
			addrs = append(addrs, prefix)
		}
		result = append(result, netmon.Interface{Interface: &net.Interface{Index: v.Index, MTU: v.MTU, Name: v.Name, Flags: net.Flags(v.Flags)}, AltAddrs: addrs})
	}
	interfaceSnapshot.Store(&result)
	return nil
}
