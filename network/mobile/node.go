// Package mobile contains the application-owned Tailscale node. Its exported
// API deliberately uses gomobile-compatible types so Android and the Windows
// helper share the same TCP/UDP implementation.
package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"cliprelay/network/transport"
	"tailscale.com/envknob"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

var tcpPorts = []int{48784, 48789, 48791, 48810}
var udpPorts = []int{48798, 48799, 48800}

type Node struct {
	server             *tsnet.Server
	ctx                context.Context
	cancel             context.CancelFunc
	mu                 sync.Mutex
	closed             bool
	started            bool
	exposed            bool
	forwards           map[string]bool
	workers            sync.WaitGroup
	peers              atomic.Pointer[map[netip.Addr]bool]
	diagnostic         atomic.Pointer[string]
	bridgeDiagnostic   atomic.Pointer[string]
	unavailableBridges atomic.Int32
}

// New requires an explicit coordination URL. There is no fallback to the
// Tailscale account service. The one-use auth key comes from ClipRelay's broker.
// dataDir must be app-private, excluded from backups, and persistent across runs.
func New(dataDir, hostname, controlURL, authKey string) (*Node, error) {
	u, err := url.Parse(controlURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("coordination URL must be an HTTPS origin")
	}
	if dataDir == "" || hostname == "" {
		return nil, errors.New("missing private state directory or hostname")
	}
	if runtime.GOOS == "android" {
		// Even with log upload disabled, LocalBackend asks logpolicy for a
		// writable state directory. Android has neither HOME nor /tmp; letting
		// it guess causes a native panic before enrollment can finish.
		if err := os.MkdirAll(dataDir, 0700); err != nil {
			return nil, err
		}
		if err := os.Setenv("TS_LOGS_DIR", dataDir); err != nil {
			return nil, err
		}
	}
	envknob.SetNoLogsNoSupport()
	ctx, cancel := context.WithCancel(context.Background())
	n := &Node{
		// A common preferred port keeps IPv4/IPv6 endpoints consistent. With
		// Port=0 upstream binds each family independently, but advertises local
		// IPv6 addresses with the IPv4 port, which breaks IPv6 hole punching.
		server: &tsnet.Server{Dir: dataDir, Hostname: hostname, ControlURL: controlURL, AuthKey: authKey, Port: 47633, Logf: logger.Discard, UserLogf: logger.Discard},
		ctx:    ctx, cancel: cancel, forwards: make(map[string]bool),
	}
	empty := map[netip.Addr]bool{}
	n.peers.Store(&empty)
	// Keep only connection failures in memory. Never retain authentication
	// material, registration URLs, key logs, or proxy user information.
	n.server.Logf = func(format string, args ...any) {
		message := fmt.Sprintf(format, args...)
		lower := strings.ToLower(message)
		if !strings.Contains(lower, "control:") || (!strings.Contains(lower, "error") && !strings.Contains(lower, "failed")) {
			return
		}
		for _, sensitive := range []string{"tskey", "authkey", "authurl", "private", "nodekey", "machinekey", "password", "bearer"} {
			if strings.Contains(lower, sensitive) {
				return
			}
		}
		message = diagnosticURL.ReplaceAllString(message, "[endpoint]")
		if len(message) > 500 {
			message = message[:500]
		}
		n.diagnostic.Store(&message)
	}
	return n, nil
}

var diagnosticURL = regexp.MustCompile(`https?://[^\s"']+`)

// BridgesReady includes the local forwarding sockets, not just enrollment.
func (n *Node) BridgesReady() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return !n.closed && (n.exposed || len(n.forwards) != 0) && n.unavailableBridges.Load() == 0
}

// BridgeDiagnostic is bounded, in-memory listener metadata; it never contains
// keys, pairing credentials or stream contents.
func (n *Node) BridgeDiagnostic() string {
	if value := n.bridgeDiagnostic.Load(); value != nil {
		return *value
	}
	return ""
}

// PeerPaths returns only the connection kind, never keys or public endpoints.
// A relay may be used while UDP hole punching is still trying a direct path.
func (n *Node) PeerPaths() (string, error) {
	n.mu.Lock()
	available := n.started && !n.closed
	n.mu.Unlock()
	if !available {
		return "{}", nil
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(n.ctx, 2*time.Second)
	defer cancel()
	status, err := client.Status(ctx)
	if err != nil {
		return "", err
	}
	paths := map[string]string{}
	for _, peer := range status.Peer {
		path := "connecting"
		if peer.Active && peer.CurAddr != "" {
			path = "direct"
		} else if peer.Active && peer.Relay != "" {
			path = "relay"
		}
		for _, ip := range peer.TailscaleIPs {
			if (*n.peers.Load())[ip] {
				paths[ip.String()] = path
			}
		}
	}
	b, err := json.Marshal(paths)
	return string(b), err
}

// Start waits at most 45 seconds for registration. Close also cancels this wait.
// Return values contain addresses, never a registration key or an account URL.
func (n *Node) Start() (string, error) {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return "", errors.New("node closed")
	}
	if !n.started {
		if err := n.server.Start(); err != nil {
			n.mu.Unlock()
			return "", err
		}
		n.started = true
	}
	n.mu.Unlock()
	ctx, cancel := context.WithTimeout(n.ctx, 45*time.Second)
	defer cancel()
	st, err := n.server.Up(ctx)
	if err != nil {
		if message := n.diagnostic.Load(); message != nil {
			return "", fmt.Errorf("%w: %s", err, *message)
		}
		return "", err
	}
	addresses := make([]string, 0, len(st.TailscaleIPs))
	for _, ip := range st.TailscaleIPs {
		addresses = append(addresses, ip.String())
	}
	b, err := json.Marshal(addresses)
	return string(b), err
}

// SetPeers replaces the host's allowlist atomically. Only explicit paired node
// addresses may reach the engine, even if the coordination ACL is misconfigured.
// Revocation also requires closing existing streams; callers must Close the node
// and reopen it with the reduced set before reporting revocation as complete.
func (n *Node) SetPeers(addressesJSON string) error {
	var addresses []string
	if err := json.Unmarshal([]byte(addressesJSON), &addresses); err != nil {
		return err
	}
	if len(addresses) > 64 {
		return errors.New("too many paired addresses")
	}
	peers := make(map[netip.Addr]bool)
	for _, value := range addresses {
		ip, err := tailnetIP(value)
		if err != nil {
			return err
		}
		peers[ip] = true
	}
	n.peers.Store(&peers)
	return nil
}

func tailnetIP(value string) (netip.Addr, error) {
	ip, err := netip.ParseAddr(value)
	if err != nil || !netip.MustParsePrefix("100.64.0.0/10").Contains(ip) {
		return netip.Addr{}, errors.New("expected a ClipRelay overlay IPv4 address")
	}
	return ip, nil
}

func (n *Node) allowPeer(addr net.Addr) bool {
	ip, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return false
	}
	p, err := netip.ParseAddr(ip)
	return err == nil && (*n.peers.Load())[p.Unmap()]
}

func allowLoopback(addr net.Addr) bool {
	host, _, err := net.SplitHostPort(addr.String())
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback()
}

// Expose serves only ClipRelay's fixed remote-desktop ports and always dials the
// host's loopback engine. It cannot forward arbitrary hosts, LANs, or web admin.
func (n *Node) Expose() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return errors.New("node closed")
	}
	if n.exposed {
		return nil
	}
	ip, _ := n.server.TailscaleIPs()
	if !ip.IsValid() {
		return errors.New("start the node before exposing the engine")
	}
	if err := n.bind(ip.String(), "127.0.0.1", true); err != nil {
		return err
	}
	n.exposed = true
	return nil
}

// Forward makes one paired host's remote engine available to the existing native
// client on a private loopback address. The native client must explicitly use
// remote packet sizing; detecting loopback as a LAN would choose an oversized MTU.
func (n *Node) Forward(peerIP, bindIP string) error {
	peer, err := tailnetIP(peerIP)
	if err != nil {
		return err
	}
	if !(*n.peers.Load())[peer] {
		return errors.New("computer is not paired")
	}
	ip := net.ParseIP(bindIP)
	if ip == nil || !ip.IsLoopback() || ip.To4() == nil {
		return errors.New("bind address must be IPv4 loopback")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return errors.New("node closed")
	}
	if !n.started {
		return errors.New("start the node before forwarding")
	}
	if n.forwards[bindIP] {
		return errors.New("loopback address already in use")
	}
	if err := n.bind(bindIP, peerIP, false); err != nil {
		return err
	}
	n.forwards[bindIP] = true
	return nil
}

// Caller holds mu. All ports bind before any worker starts; failure rolls back.
func (n *Node) bind(bindIP, targetIP string, expose bool) (err error) {
	var closers []io.Closer
	var jobs []func()
	defer func() {
		if err != nil {
			for _, c := range closers {
				c.Close()
			}
		}
	}()
	var dial transport.DialFunc = n.server.Dial
	allow := allowLoopback
	if expose {
		dial = (&net.Dialer{}).DialContext
		allow = n.allowPeer
	}
	for _, port := range tcpPorts {
		addr := net.JoinHostPort(bindIP, fmt.Sprint(port))
		target := net.JoinHostPort(targetIP, fmt.Sprint(port))
		var ln net.Listener
		if expose {
			ln, err = n.server.Listen("tcp4", addr)
		} else {
			ln, err = net.Listen("tcp4", addr)
		}
		if err != nil {
			return err
		}
		closers = append(closers, ln)
		jobs = append(jobs, func() { transport.TCP(n.ctx, ln, dial, target, allow) })
	}
	for _, port := range udpPorts {
		addr := net.JoinHostPort(bindIP, fmt.Sprint(port))
		target := net.JoinHostPort(targetIP, fmt.Sprint(port))
		listen := func() (net.PacketConn, error) {
			if expose {
				return n.server.ListenPacket("udp4", addr)
			}
			return net.ListenPacket("udp4", addr)
		}
		var pc net.PacketConn
		pc, err = listen()
		if err != nil {
			return err
		}
		closers = append(closers, pc)
		jobs = append(jobs, func() {
			available := true
			transport.RecoveringUDP(n.ctx, pc, listen, dial, target, allow, func(ready bool, failure error) {
				if ready != available {
					if ready {
						n.unavailableBridges.Add(-1)
					} else {
						n.unavailableBridges.Add(1)
					}
					available = ready
				}
				if failure != nil {
					message := fmt.Sprintf("UDP %d: %v", port, failure)
					if len(message) > 500 {
						message = message[:500]
					}
					n.bridgeDiagnostic.Store(&message)
				}
			})
		})
	}
	for _, job := range jobs {
		n.workers.Add(1)
		go func() { defer n.workers.Done(); job() }()
	}
	return nil
}

func (n *Node) Close() error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return nil
	}
	n.closed = true
	n.cancel()
	started := n.started
	n.mu.Unlock()
	var err error
	if started {
		err = n.server.Close()
	}
	n.workers.Wait()
	return err
}
