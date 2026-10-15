//go:build integration

package mobile_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"

	"cliprelay/network/desktopclient"
	"cliprelay/network/mobile"
)

type pairedVideoNode struct {
	*mobile.Node
	authorize func(string) error
}

func (n *pairedVideoNode) Start() (string, error) {
	addresses, err := n.Node.Start()
	if err == nil {
		err = n.authorize(addresses)
	}
	return addresses, err
}

func TestDesktopViewerNetworkFixture(t *testing.T) {
	value := os.Getenv("CLIPRELAY_TEST_ENGINE_PORT")
	if value == "" {
		t.Skip("explicit isolated engine fixture required")
	}
	port, err := strconv.Atoi(value)
	if err != nil {
		t.Fatal(err)
	}
	node, peer, authorize := mobile.DesktopVideoFixture(t, port)
	metadata, _ := json.Marshal(map[string]any{"type": "fixture-ready", "peerIP": peer, "controlUrl": "https://fixture.invalid"})
	fmt.Println(string(metadata))
	err = desktopclient.Run(context.Background(), os.Stdin, os.Stdout, func(init desktopclient.Init) (desktopclient.Driver, error) {
		if init.PeerIP != peer || init.ControlURL != "https://fixture.invalid" {
			return nil, fmt.Errorf("unexpected fixture initialization")
		}
		return &pairedVideoNode{Node: node, authorize: authorize}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
