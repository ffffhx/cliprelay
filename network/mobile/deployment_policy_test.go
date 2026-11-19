package mobile

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// The deployed ACL must admit every fixed application channel, including the
// first-pairing bootstrap. Merely testing tsnet forwarding misses ACL drops.
func TestDeploymentPolicyMatchesApplicationChannels(t *testing.T) {
	data, err := os.ReadFile("../deploy/policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		ACLs []struct {
			Action string   `json:"action"`
			Src    []string `json:"src"`
			Proto  string   `json:"proto"`
			Dst    []string `json:"dst"`
		} `json:"acls"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	want := map[string]map[int]bool{"tcp": {}, "udp": {}}
	for _, port := range tcpPorts {
		want["tcp"][port] = true
	}
	for _, port := range udpPorts {
		want["udp"][port] = true
	}
	for _, acl := range policy.ACLs {
		if acl.Action != "accept" || len(acl.Src) != 1 || acl.Src[0] != "autogroup:member" || want[acl.Proto] == nil {
			t.Fatalf("Unexpected coordination rule: %+v", acl)
		}
		for _, dst := range acl.Dst {
			if !strings.HasPrefix(dst, "autogroup:self:") {
				t.Fatalf("Rule must remain isolated to its owner: %s", dst)
			}
			bounds := strings.Split(strings.TrimPrefix(dst, "autogroup:self:"), "-")
			if len(bounds) > 2 {
				t.Fatalf("Invalid range: %s", dst)
			}
			first, err := strconv.Atoi(bounds[0])
			if err != nil {
				t.Fatal(err)
			}
			last := first
			if len(bounds) == 2 {
				last, err = strconv.Atoi(bounds[1])
				if err != nil {
					t.Fatal(err)
				}
			}
			if first < 1 || last < first || last > 65535 {
				t.Fatalf("Invalid range: %s", dst)
			}
			for port := first; port <= last; port++ {
				if !want[acl.Proto][port] {
					t.Fatalf("Unexpected or duplicate %s port %d (admin must stay private)", acl.Proto, port)
				}
				delete(want[acl.Proto], port)
			}
		}
	}
	for proto, missing := range want {
		if len(missing) != 0 {
			t.Fatalf("Deployed policy drops application %s ports: %v", proto, missing)
		}
	}
}
