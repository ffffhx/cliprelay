// The helper is owned by ClipRelay's installed Windows service. Standard input
// and output carry bounded local control messages; node credentials stay in the
// service's ACL-protected state directory, outside the tray process.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"cliprelay/network/inputfocus"
	"cliprelay/network/mobile"
)

const pairingURL = "https://124-221-36-36.anyip.dev:8443/cliprelay-network"

type peer struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Online    bool     `json:"online"`
	Path      string   `json:"path,omitempty"`
}
type state struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	State       string           `json:"state"`
	Addresses   []string         `json:"addresses"`
	Peers       []peer           `json:"peers"`
	Pending     []map[string]any `json:"pending"`
	Ready       bool             `json:"ready"`
	Reauthorize bool             `json:"reauthorize,omitempty"`
	Error       string           `json:"error"`
}
type runtime struct {
	mu        sync.Mutex
	value     state
	client    *mobile.PairingClient
	dir, name string
}

func main() {
	stateDir := flag.String("state-dir", "", "ACL-protected persistent directory")
	focusProbe := flag.String("input-focus-probe", "", "serve paired input-focus metadata using this local probe")
	flag.Parse()
	if *stateDir == "" {
		fmt.Fprintln(os.Stderr, "state directory required")
		os.Exit(2)
	}
	if err := os.MkdirAll(*stateDir, 0700); err != nil {
		os.Exit(2)
	}
	if *focusProbe != "" {
		if inputfocus.Serve(context.Background(), *stateDir, *focusProbe) != nil {
			os.Exit(1)
		}
		return
	}
	credentialPath := filepath.Join(*stateDir, "device-credential")
	credential, err := os.ReadFile(credentialPath)
	if os.IsNotExist(err) {
		value, e := mobile.NewCredential()
		if e != nil {
			os.Exit(2)
		}
		credential = []byte(value)
		err = os.WriteFile(credentialPath, credential, 0600)
	}
	if err != nil {
		os.Exit(2)
	}
	client, err := mobile.NewPairingClient(pairingURL, strings.TrimSpace(string(credential)))
	if err != nil {
		os.Exit(2)
	}
	name, _ := os.Hostname()
	app := &runtime{client: client, dir: *stateDir, name: name, value: state{State: "starting", Name: name}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan struct{})
	go func() { defer close(finished); app.run(ctx) }()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 16384)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req struct {
			Action string `json:"action"`
			ID     string `json:"id"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			encoder.Encode(map[string]any{"ok": false, "error": "invalid command"})
			continue
		}
		if req.Action == "shutdown" {
			break
		}
		var response any
		var err error
		switch req.Action {
		case "status":
			app.mu.Lock()
			response = app.value
			app.mu.Unlock()
		case "code", "approve", "revoke":
			data, _ := json.Marshal(map[string]string{"id": req.ID})
			if req.Action == "code" {
				data = []byte("{}")
			}
			var raw string
			raw, err = client.Request(req.Action, string(data))
			if err == nil {
				err = json.Unmarshal([]byte(raw), &response)
			}
		default:
			err = fmt.Errorf("unknown command")
		}
		if err != nil {
			encoder.Encode(map[string]any{"ok": false, "error": err.Error()})
		} else {
			encoder.Encode(map[string]any{"ok": true, "data": response})
		}
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(15 * time.Second):
	}
}

func (r *runtime) run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := r.session(ctx); err != nil {
			r.mu.Lock()
			r.value.Ready = false
			r.value.Error = err.Error()
			r.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (r *runtime) session(ctx context.Context) error {
	name, _ := json.Marshal(map[string]string{"name": r.name})
	if _, err := r.client.Request("host", string(name)); err != nil {
		return err
	}
	raw, err := r.client.Request("enroll", "")
	if err != nil {
		return err
	}
	var enrollment struct {
		ControlURL string `json:"controlUrl"`
		Hostname   string `json:"hostname"`
		AuthKey    string `json:"authKey"`
	}
	if err = json.Unmarshal([]byte(raw), &enrollment); err != nil {
		return err
	}
	node, err := mobile.New(filepath.Join(r.dir, "node"), enrollment.Hostname, enrollment.ControlURL, enrollment.AuthKey)
	if err != nil {
		return err
	}
	defer node.Close()
	stop := context.AfterFunc(ctx, func() { node.Close() })
	defer stop()
	if _, err = node.Start(); err != nil {
		return err
	}
	if err = node.Expose(); err != nil {
		return err
	}
	var previous []string
	for ctx.Err() == nil {
		raw, err = r.client.Request("status", "")
		if err != nil {
			if strings.Contains(err.Error(), "401:") {
				return err
			}
			r.mu.Lock()
			r.value.Error = "正在恢复设备状态"
			r.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(3 * time.Second):
				continue
			}
		}
		var value state
		if err = json.Unmarshal([]byte(raw), &value); err != nil {
			return err
		}
		if value.Reauthorize {
			return fmt.Errorf("renewing expired network registration")
		}
		ips := []string{}
		for _, p := range value.Peers {
			for _, ip := range p.Addresses {
				if strings.Contains(ip, ":") {
					continue
				}
				ips = append(ips, ip)
			}
		}
		// Removing a peer must also terminate its already accepted TCP streams.
		for _, old := range previous {
			present := false
			for _, ip := range ips {
				if ip == old {
					present = true
				}
			}
			if !present {
				return fmt.Errorf("paired device removed; renewing network connections")
			}
		}
		if !reflect.DeepEqual(previous, ips) {
			b, _ := json.Marshal(ips)
			if err = node.SetPeers(string(b)); err != nil {
				return err
			}
			previous = ips
		}
		if rawPaths, pathErr := node.PeerPaths(); pathErr == nil {
			var paths map[string]string
			if json.Unmarshal([]byte(rawPaths), &paths) == nil {
				for i := range value.Peers {
					for _, ip := range value.Peers[i].Addresses {
						if paths[ip] != "" {
							value.Peers[i].Path = paths[ip]
						}
					}
				}
			}
		}
		value.Ready = node.BridgesReady()
		if !value.Ready {
			value.Error = "正在恢复串流通道"
		}
		r.mu.Lock()
		r.value = value
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(3 * time.Second):
		}
	}
	return nil
}
