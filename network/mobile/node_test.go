package mobile

import (
	"encoding/json"
	"testing"
)

func TestRequiresExplicitHTTPSCoordinator(t *testing.T) {
	for _, u := range []string{"", "http://localhost", "https://a.invalid/path", "https://user:password@a.invalid", "https://a.invalid/?token=secret"} {
		if n, err := New(t.TempDir(), "test", u, ""); err == nil {
			n.Close()
			t.Fatalf("accepted %q", u)
		}
	}
}

func TestPeerValidation(t *testing.T) {
	n, err := New(t.TempDir(), "test", "https://control.invalid", "")
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	for _, ip := range []string{"127.0.0.1", "192.168.0.1", "8.8.8.8", "invalid"} {
		b, _ := json.Marshal([]string{ip})
		if n.SetPeers(string(b)) == nil {
			t.Fatalf("accepted %s", ip)
		}
	}
	if err := n.SetPeers(`["100.64.0.2"]`); err != nil {
		t.Fatal(err)
	}
	if err := n.Forward("100.64.0.2", "0.0.0.0"); err == nil {
		t.Fatal("exposed client proxy to LAN")
	}
}

func TestAndroidInterfaceValidation(t *testing.T) {
	if err := SetInterfaces(`[{"index":2,"mtu":1500,"name":"wlan0","flags":1,"addresses":["192.168.1.2/24","2001:db8::1/64"]}]`); err != nil {
		t.Fatal(err)
	}
	if got := (*interfaceSnapshot.Load())[0].AltAddrs[0].String(); got != "192.168.1.2/24" {
		t.Fatalf("host address was changed to subnet: %s", got)
	}
	if err := SetInterfaces(`[{"index":2,"mtu":1500,"name":"wlan0","addresses":["broken"]}]`); err == nil {
		t.Fatal("accepted malformed address")
	}
}
