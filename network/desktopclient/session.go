// Package desktopclient owns one desktop controller's private network channel.
// Enrollment credentials arrive only over the owning application's stdin pipe.
package desktopclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"time"

	"cliprelay/network/mobile"
)

type Init struct {
	Version    int    `json:"version"`
	ControlURL string `json:"controlUrl"`
	Hostname   string `json:"hostname"`
	AuthKey    string `json:"authKey"`
	PeerIP     string `json:"peerIP"`
}

type Driver interface {
	Start() (string, error)
	SetPeers(string) error
	ForwardLocal(string) (int, error)
	BridgesReady() bool
	PeerPaths() (string, error)
	Close() error
}

type Factory func(Init) (Driver, error)

func FactoryForDirectory(directory string) Factory {
	return func(init Init) (Driver, error) {
		if err := os.MkdirAll(directory, 0700); err != nil {
			return nil, err
		}
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("invalid private directory")
		}
		if err := os.Chmod(directory, 0700); err != nil {
			return nil, err
		}
		// Keep IPv4 and IPv6 on the same preferred port without taking the host
		// service's fixed port. A competing bind fails startup and is retried by
		// the owner; it never silently switches to the user's system VPN.
		socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		port := socket.LocalAddr().(*net.UDPAddr).Port
		socket.Close()
		return mobile.NewWithPort(directory, init.Hostname, init.ControlURL, init.AuthKey, port)
	}
}

func decode(raw []byte, destination any) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(destination) != nil {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF
}

func valid(init Init) bool {
	origin, err := url.Parse(init.ControlURL)
	if err != nil || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return false
	}
	ip, err := netip.ParseAddr(init.PeerIP)
	return init.Version == 1 && len(init.ControlURL) <= 2048 && len(init.AuthKey) <= 4096 &&
		regexp.MustCompile(`^cr-[a-f0-9]{24}$`).MatchString(init.Hostname) && err == nil &&
		netip.MustParsePrefix("100.64.0.0/10").Contains(ip)
}

// Run never returns provider error text: errors can contain enrollment URLs or
// credentials. It reports only fixed codes. Closing stdin cancels even a pending
// Start call and waits for the node's sockets to close before returning.
func Run(parent context.Context, input io.Reader, output io.Writer, factory Factory) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	frames := make(chan []byte)
	readFailure := make(chan struct{}, 1)
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 16384)
		for scanner.Scan() {
			frame := append([]byte(nil), scanner.Bytes()...)
			select {
			case frames <- frame:
			case <-ctx.Done():
				return
			}
		}
		if scanner.Err() != nil {
			readFailure <- struct{}{}
		}
		cancel()
	}()
	var init Init
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case frame, ok := <-frames:
		if !ok || !decode(frame, &init) || !valid(init) {
			return errors.New("INVALID_INITIALIZATION")
		}
		clear(frame)
	case <-timer.C:
		return errors.New("INITIALIZATION_TIMEOUT")
	case <-ctx.Done():
		return nil
	}
	node, err := factory(init)
	if err != nil {
		return errors.New("NODE_UNAVAILABLE")
	}
	stop := context.AfterFunc(ctx, func() { node.Close() })
	defer func() { cancel(); stop(); node.Close() }()
	peers, _ := json.Marshal([]string{init.PeerIP})
	if node.SetPeers(string(peers)) != nil {
		return errors.New("INVALID_PEER")
	}
	encoder := json.NewEncoder(output)
	base, started := 0, false
	status := func() error {
		path := "connecting"
		if started {
			if raw, err := node.PeerPaths(); err == nil {
				var paths map[string]string
				if json.Unmarshal([]byte(raw), &paths) == nil && (paths[init.PeerIP] == "direct" || paths[init.PeerIP] == "relay") {
					path = paths[init.PeerIP]
				}
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return encoder.Encode(struct {
			Type  string `json:"type"`
			Ready bool   `json:"ready"`
			Port  int    `json:"port"`
			Path  string `json:"path"`
		}{"status", started && node.BridgesReady(), base, path})
	}
	if status() != nil {
		return nil
	}
	type startResult struct {
		port int
		err  error
	}
	ready := make(chan startResult, 1)
	go func() {
		_, err := node.Start()
		port := 0
		if err == nil && ctx.Err() == nil {
			port, err = node.ForwardLocal(init.PeerIP)
		}
		ready <- startResult{port, err}
	}()
	for {
		select {
		case <-ctx.Done():
			select {
			case <-readFailure:
				return errors.New("INVALID_COMMAND")
			default:
				return nil
			}
		case result := <-ready:
			if ctx.Err() != nil {
				return nil
			}
			if result.err != nil || result.port < 1029 || result.port > 65514 {
				return errors.New("CONNECTION_FAILED")
			}
			base, started = result.port, true
			if status() != nil {
				return nil
			}
		case frame, ok := <-frames:
			if !ok {
				return nil
			}
			var command struct {
				Action string `json:"action"`
			}
			if !decode(frame, &command) || len(frame) > 128 {
				return errors.New("INVALID_COMMAND")
			}
			switch command.Action {
			case "shutdown":
				return nil
			case "status":
				if status() != nil {
					return nil
				}
			default:
				return errors.New("INVALID_COMMAND")
			}
		}
	}
}
