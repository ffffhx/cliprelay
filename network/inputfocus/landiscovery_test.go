package inputfocus

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLANDiscoveryReplyIsBoundedAndEchoesOnlyAValidNonce(t *testing.T) {
	for _, packet := range []string{"", discoveryPrefix, discoveryPrefix + strings.Repeat("f", 33), "GET /status", discoveryPrefix + "../../secret"} {
		if discoveryReply([]byte(packet), "pc") != nil {
			t.Fatal("invalid discovery request accepted")
		}
	}
	response := discoveryReply([]byte(discoveryPrefix+strings.Repeat("a", 32)), "test PC")
	var value map[string]any
	if len(response) > 256 || json.Unmarshal(response, &value) != nil || len(value) != 4 || value["nonce"] != strings.Repeat("a", 32) || value["port"] != float64(48789) {
		t.Fatal("invalid discovery response")
	}
}
