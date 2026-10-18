package main

import (
	"context"
	"net/http"
	"reflect"
	"testing"
)

func TestRouteAddressesPreservePublicTLSAndDenyOtherTargets(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "0.1.2.3", "::1", "invalid"} {
		if _, err := routeClient("owned-fixture.trycloudflare.com", []string{address}); err == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	if _, err := routeClient("localhost", []string{"104.16.1.1"}); err == nil {
		t.Fatal("foreign hostname accepted")
	}
	client, err := routeClient("owned-fixture.trycloudflare.com", []string{"104.16.1.1"})
	if err != nil {
		t.Fatal(err)
	}
	transport := client.Transport.(*http.Transport)
	if transport.TLSClientConfig.InsecureSkipVerify || transport.TLSClientConfig.ServerName != "" || transport.Proxy != nil {
		t.Fatal("public TLS or direct routing changed")
	}
	if _, err = transport.DialContext(context.Background(), "tcp", "foreign.invalid:443"); err == nil {
		t.Fatal("foreign destination accepted")
	}
	if client.CheckRedirect(nil, nil) == nil {
		t.Fatal("redirect accepted")
	}
}

func TestFixturePortsKeepAdministrationHostLocal(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		for _, mode := range []string{"", "synthetic", "mac-audio", "unknown"} {
			tcp, udp, err := ports(mode, platform)
			allowed := mode == "" || mode == "synthetic" || mode == "mac-audio" && platform == "darwin"
			if (err == nil) != allowed {
				t.Fatalf("%s/%s admission", platform, mode)
			}
			if !allowed {
				continue
			}
			for _, port := range tcp {
				if port == 48790 {
					t.Fatal("administration exposed")
				}
			}
			if mode == "mac-audio" {
				if !reflect.DeepEqual(tcp, []int{48784, 48789, 48791, 48792, 48810, 48830}) || !reflect.DeepEqual(udp, []int{48798, 48799, 48800}) {
					t.Fatal("native allowlist changed")
				}
			} else if !reflect.DeepEqual(tcp, []int{48789, 48830}) || !reflect.DeepEqual(udp, []int{48798}) {
				t.Fatal("synthetic allowlist changed")
			}
		}
	}
}
