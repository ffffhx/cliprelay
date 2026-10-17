package main

import (
	"reflect"
	"testing"
)

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
