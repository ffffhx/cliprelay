package mobile

import (
	"net"
	"strconv"
	"testing"
)

func TestDesktopPortCollisionRollsBackWholeGroup(t *testing.T) {
	node, err := New(t.TempDir(), "fixture", "https://fixture.invalid", "")
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()
	var blocker net.PacketConn
	base := 0
	for attempt := 0; attempt < 32; attempt++ {
		listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		// Occupy the second UDP port. Forwarding must roll back all four TCP
		// listeners and the first UDP listener acquired before this conflict.
		candidate := listener.LocalAddr().(*net.UDPAddr).Port - 10
		if candidate < 1029 || candidate > 65514 {
			listener.Close()
			continue
		}
		base, blocker = candidate, listener
		break
	}
	if blocker == nil {
		t.Fatal("could not reserve a port collision fixture")
	}
	defer blocker.Close()
	node.mu.Lock()
	err = node.bindPorts("127.0.0.1", "100.64.0.2", false, base-48789)
	node.mu.Unlock()
	if err == nil {
		t.Fatal("accepted an incomplete local forwarding group")
	}
	for _, offset := range []int{-5, 0, 2, 21} {
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(base+offset)))
		if err != nil {
			t.Fatal("failed port allocation leaked a TCP listener", offset, err)
		}
		listener.Close()
	}
	listener, err := net.ListenPacket("udp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(base+9)))
	if err != nil {
		t.Fatal("failed port allocation leaked the first UDP listener", err)
	}
	listener.Close()
	if node.BridgesReady() {
		t.Fatal("incomplete forwarding group reported ready")
	}
}
