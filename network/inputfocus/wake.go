package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

type wakeAddress struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
}
type wakeAdapter struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Kind            string        `json:"kind"`
	MAC             string        `json:"mac"`
	Connected       bool          `json:"connected"`
	Addresses       []wakeAddress `json:"addresses"`
	MagicPacket     string        `json:"magicPacket"`
	PowerManagement string        `json:"powerManagement"`
	WakeArmed       string        `json:"wakeArmed"`
	Configuration   string        `json:"configuration"`
}
type wakeInventory struct {
	OK           bool          `json:"ok"`
	Supported    bool          `json:"supported"`
	Code         string        `json:"code,omitempty"`
	Platform     string        `json:"platform"`
	Adapters     []wakeAdapter `json:"adapters"`
	WakeVerified bool          `json:"wakeVerified"`
}
type wakeRequest struct {
	Op      string `json:"op"`
	ID      string `json:"id,omitempty"`
	MAC     string `json:"mac,omitempty"`
	Network string `json:"network,omitempty"`
}
type wakeResult struct {
	OK           bool   `json:"ok"`
	Code         string `json:"code,omitempty"`
	State        string `json:"state"`
	Sent         int    `json:"sent"`
	WakeVerified bool   `json:"wakeVerified"`
}
type wakeReceipt struct {
	request wakeRequest
	result  wakeResult
	status  int
	until   time.Time
}
type wakeRoute struct{ source, broadcast netip.Addr }
type wakeControl struct {
	clients  string
	read     func(string) (json.RawMessage, error)
	now      func() time.Time
	send     func(context.Context, []wakeRoute, []byte, func() bool) (int, error)
	receipts map[string]wakeReceipt
	owners   map[string]time.Time
	global   []time.Time
}

// A helper can emit only the standard fixed-size magic packet on its own
// current physical LAN. Clients cannot select a destination IP, UDP port,
// arbitrary payload, shell command, or a VPN/loopback interface.
func wakePayload(mac string) ([]byte, error) {
	if len(mac) != 17 || mac[2] != ':' || mac[5] != ':' || mac[8] != ':' || mac[11] != ':' || mac[14] != ':' {
		return nil, errors.New("invalid MAC")
	}
	raw, err := hex.DecodeString(strings.ReplaceAll(mac, ":", ""))
	if err != nil || len(raw) != 6 || raw[0]&1 != 0 {
		return nil, errors.New("invalid MAC")
	}
	zero := true
	for _, value := range raw {
		if value != 0 {
			zero = false
		}
	}
	if zero {
		return nil, errors.New("invalid MAC")
	}
	packet := make([]byte, 102)
	for i := 0; i < 6; i++ {
		packet[i] = 255
	}
	for i := 6; i < len(packet); i += 6 {
		copy(packet[i:i+6], raw)
	}
	return packet, nil
}
func wakeConfiguration(power, magic, armed string) string {
	if power != "enabled" {
		if power == "disabled" {
			return "disabled"
		}
		return "unknown"
	}
	if magic == "unsupported" {
		return "unsupported"
	}
	if magic == "disabled" || armed == "disabled" {
		return "disabled"
	}
	if magic == "enabled" && armed == "enabled" {
		return "configured"
	}
	return "unknown"
}
func wakeSetting(value string) bool {
	return value == "enabled" || value == "disabled" || value == "unsupported" || value == "unknown"
}
func validWakeInventory(value wakeInventory) bool {
	if !value.OK || !value.Supported || (value.Platform != "windows" && value.Platform != "macos") || value.WakeVerified || len(value.Adapters) > 32 {
		return false
	}
	ids := make(map[string]bool)
	for _, adapter := range value.Adapters {
		_, macErr := wakePayload(adapter.MAC)
		if !displayInstance.MatchString(adapter.ID) || ids[strings.ToLower(adapter.ID)] || len(adapter.Name) > 512 || strings.ContainsAny(adapter.Name, "\x00\r\n") ||
			(adapter.Kind != "ethernet" && adapter.Kind != "wifi") || macErr != nil || len(adapter.Addresses) > 8 ||
			!wakeSetting(adapter.MagicPacket) || !wakeSetting(adapter.PowerManagement) ||
			(adapter.WakeArmed != "enabled" && adapter.WakeArmed != "disabled" && adapter.WakeArmed != "unknown") ||
			adapter.Configuration != wakeConfiguration(adapter.PowerManagement, adapter.MagicPacket, adapter.WakeArmed) {
			return false
		}
		ids[strings.ToLower(adapter.ID)] = true
		for _, item := range adapter.Addresses {
			address, err := netip.ParseAddr(item.Address)
			if err != nil || !address.Is4() || address.IsLoopback() || address.IsUnspecified() || address.IsMulticast() || item.Prefix < 1 || item.Prefix > 32 {
				return false
			}
		}
	}
	return true
}
func (p *wakeControl) inventory() (wakeInventory, error) {
	raw, err := p.read("wake-status")
	var value wakeInventory
	if err != nil || len(raw) > 65536 || json.Unmarshal(raw, &value) != nil || !validWakeInventory(value) {
		return value, errors.New("wake inventory unavailable")
	}
	return value, nil
}
func wakeRoutes(inventory wakeInventory, network string) []wakeRoute {
	wanted, err := netip.ParsePrefix(network)
	if err != nil || !wanted.Addr().Is4() || wanted.Bits() < 1 || wanted.Bits() > 30 || wanted != wanted.Masked() || wanted.String() != network {
		return nil
	}
	mask := net.CIDRMask(wanted.Bits(), 32)
	base := wanted.Addr().As4()
	var broadcast [4]byte
	for i := range base {
		broadcast[i] = base[i] | ^mask[i]
	}
	seen := make(map[netip.Addr]bool)
	var routes []wakeRoute
	for _, adapter := range inventory.Adapters {
		if !adapter.Connected {
			continue
		}
		for _, item := range adapter.Addresses {
			source, err := netip.ParseAddr(item.Address)
			if err != nil || !source.Is4() || seen[source] || item.Prefix != wanted.Bits() || netip.PrefixFrom(source, item.Prefix).Masked() != wanted || source == wanted.Addr() || source == netip.AddrFrom4(broadcast) {
				continue
			}
			seen[source] = true
			routes = append(routes, wakeRoute{source, netip.AddrFrom4(broadcast)})
			if len(routes) == 8 {
				return routes
			}
		}
	}
	return routes
}
func writeWakeDatagram(source netip.Addr, target *net.UDPAddr, payload []byte) error {
	connection, err := net.ListenUDP("udp4", &net.UDPAddr{IP: source.AsSlice()})
	if err != nil {
		return err
	}
	defer connection.Close()
	if err = connection.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	count, err := connection.WriteToUDP(payload, target)
	if err != nil {
		return err
	}
	if count != len(payload) {
		return io.ErrShortWrite
	}
	return nil
}
func sendWake(ctx context.Context, routes []wakeRoute, payload []byte, allowed func() bool) (int, error) {
	sent := 0
	var last error
	for round := 0; round < 3; round++ {
		for _, route := range routes {
			if ctx.Err() != nil {
				return sent, ctx.Err()
			}
			if !allowed() {
				return sent, errors.New("pairing revoked")
			}
			if err := writeWakeDatagram(route.source, &net.UDPAddr{IP: route.broadcast.AsSlice(), Port: 9}, payload); err != nil {
				last = err
			} else {
				sent++
			}
		}
		if round < 2 {
			select {
			case <-ctx.Done():
				return sent, ctx.Err()
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	if sent == 0 {
		if last == nil {
			last = errors.New("no physical LAN route")
		}
		return 0, last
	}
	return sent, nil
}
func (p *wakeControl) reserve(owner string) bool {
	now := p.now()
	if p.receipts == nil {
		p.receipts = make(map[string]wakeReceipt)
	}
	if p.owners == nil {
		p.owners = make(map[string]time.Time)
	}
	for key, entry := range p.receipts {
		if !now.Before(entry.until) {
			delete(p.receipts, key)
		}
	}
	for key, last := range p.owners {
		if now.Sub(last) >= 2*time.Minute {
			delete(p.owners, key)
		}
	}
	cut := 0
	for cut < len(p.global) && now.Sub(p.global[cut]) >= time.Minute {
		cut++
	}
	p.global = p.global[cut:]
	last, exists := p.owners[owner]
	if (exists && now.Sub(last) < 10*time.Second) || len(p.global) >= 60 || len(p.receipts) >= 256 || (!exists && len(p.owners) >= 256) {
		return false
	}
	p.owners[owner] = now
	p.global = append(p.global, now)
	return true
}
func (p *wakeControl) handler(next http.Handler) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/wake" {
			next.ServeHTTP(w, r)
			return
		}
		reply := func(status int, value any) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		fail := func(status int, code string) { reply(status, wakeResult{Code: code, State: "failed"}) }
		allowed := func() bool {
			return r.TLS != nil && len(r.TLS.PeerCertificates) == 1 && paired(p.clients, r.TLS.PeerCertificates[0].Raw)
		}
		if !allowed() {
			fail(403, "WAKE_UNPAIRED")
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			fail(415, "WAKE_BAD_REQUEST")
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			fail(429, "WAKE_BUSY")
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		var request wakeRequest
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			fail(400, "WAKE_BAD_REQUEST")
			return
		}
		if request.Op == "status" {
			if request.ID != "" || request.MAC != "" || request.Network != "" {
				fail(400, "WAKE_BAD_REQUEST")
				return
			}
			state, err := p.inventory()
			if !allowed() {
				fail(403, "WAKE_UNPAIRED")
				return
			}
			if err != nil {
				fail(503, "WAKE_UNAVAILABLE")
				return
			}
			reply(200, state)
			return
		}
		payload, err := wakePayload(request.MAC)
		network, networkErr := netip.ParsePrefix(request.Network)
		if request.Op != "send" || !fileID.MatchString(request.ID) || err != nil || networkErr != nil || !network.Addr().Is4() || network.Bits() < 1 || network.Bits() > 30 || network.Masked() != network || network.String() != request.Network {
			fail(400, "WAKE_BAD_REQUEST")
			return
		}
		request.MAC = strings.ToUpper(request.MAC)
		if !allowed() {
			fail(403, "WAKE_UNPAIRED")
			return
		}
		digest := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
		owner := hex.EncodeToString(digest[:])
		key := owner + ":" + request.ID
		if prior, exists := p.receipts[key]; exists && p.now().Before(prior.until) {
			if prior.request != request {
				fail(409, "WAKE_ID_CONFLICT")
				return
			}
			reply(prior.status, prior.result)
			return
		}
		if !p.reserve(owner) {
			fail(429, "WAKE_RATE_LIMITED")
			return
		}
		state, err := p.inventory()
		if !allowed() {
			fail(403, "WAKE_UNPAIRED")
			return
		}
		if err != nil {
			fail(503, "WAKE_UNAVAILABLE")
			return
		}
		routes := wakeRoutes(state, request.Network)
		if len(routes) == 0 {
			fail(409, "WAKE_NOT_ON_LAN")
			return
		}
		// Save before transmitting: a lost response must not send another burst.
		result := wakeResult{State: "failed", Code: "WAKE_SEND_FAILED"}
		p.receipts[key] = wakeReceipt{request, result, 503, p.now().Add(2 * time.Minute)}
		send := p.send
		if send == nil {
			send = sendWake
		}
		sent, sendErr := send(r.Context(), routes, payload, allowed)
		if sent < 0 || sent > len(routes)*3 {
			sent = 0
			sendErr = errors.New("invalid sender result")
		}
		status := 503
		if sent > 0 {
			result = wakeResult{OK: true, State: "sent", Sent: sent}
			status = 200
		} else if sendErr == nil {
			result.Code = "WAKE_SEND_FAILED"
		}
		p.receipts[key] = wakeReceipt{request, result, status, p.now().Add(2 * time.Minute)}
		if !allowed() {
			fail(403, "WAKE_UNPAIRED")
			return
		}
		reply(status, result)
	})
}
