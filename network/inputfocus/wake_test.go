package inputfocus

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const wakeTestMAC = "02:11:22:33:44:55"

func wakeBody() string {
	return `{"op":"send","id":"1234567890abcdef1234567890abcdef","mac":"02:11:22:33:44:55","network":"192.168.0.0/24"}`
}

type wakeFixture struct {
	control      *wakeControl
	state        wakeInventory
	now          time.Time
	reads, sends int
	onRead       func()
}

func newWakeFixture(t *testing.T) (*wakeFixture, http.Handler) {
	t.Helper()
	f := &wakeFixture{now: time.Now(), state: wakeInventory{OK: true, Supported: true, Platform: "windows", Adapters: []wakeAdapter{{
		ID: testDisplayInstance, Name: "Wi-Fi", Kind: "wifi", MAC: "02:AA:BB:CC:DD:EE", Connected: true, Addresses: []wakeAddress{{"192.168.0.2", 24}},
		MagicPacket: "enabled", PowerManagement: "unsupported", WakeArmed: "disabled", Configuration: "unknown"}}}}
	f.control = &wakeControl{clients: filepath.Join(t.TempDir(), "clients.json"), now: func() time.Time { return f.now },
		read: func(command string) (json.RawMessage, error) {
			f.reads++
			if command != "wake-status" {
				t.Fatal("unexpected worker command")
			}
			if f.onRead != nil {
				f.onRead()
			}
			return json.Marshal(f.state)
		},
		send: func(ctx context.Context, routes []wakeRoute, payload []byte, allowed func() bool) (int, error) {
			if !allowed() || len(routes) != 1 || routes[0].source.String() != "192.168.0.2" || routes[0].broadcast.String() != "192.168.0.255" {
				t.Fatal("invalid route")
			}
			expected, _ := wakePayload(wakeTestMAC)
			if !bytes.Equal(payload, expected) {
				t.Fatal("arbitrary payload")
			}
			f.sends++
			return 3, nil
		}}
	filePairing(t, f.control.clients, []byte("first"), []byte("second"))
	return f, f.control.handler(http.NotFoundHandler())
}
func TestWakePayloadRejectsInvalidMACAndEncodesExactPacket(t *testing.T) {
	for _, mac := range []string{"", "00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "01:11:22:33:44:55", "02:11:22", "02:11:22:33:44:55:66", "02:11:22:33:44:555", "02-11-22-33-44-55", "02:11:22:33:44:GG", " 02:11:22:33:44:55"} {
		if _, err := wakePayload(mac); err == nil {
			t.Fatal("accepted invalid MAC", mac)
		}
	}
	value, err := wakePayload("02:ab:cd:ef:12:34")
	if err != nil || len(value) != 102 {
		t.Fatal(err)
	}
	if !bytes.Equal(value[:6], bytes.Repeat([]byte{255}, 6)) || !bytes.Equal(value[6:], bytes.Repeat([]byte{2, 171, 205, 239, 18, 52}, 16)) {
		t.Fatal("wrong magic packet")
	}
}
func TestWakeRequestsRequirePairingAndStrictFields(t *testing.T) {
	f, h := newWakeFixture(t)
	for _, peer := range [][]byte{nil, []byte("unknown")} {
		if fileCall(h, peer, "POST", "/v1/wake", wakeBody()).Code != 403 {
			t.Fatal("unpaired")
		}
	}
	for _, bad := range []string{wakeBody() + "{}", `{"op":"status","mac":"02:11:22:33:44:55"}`, strings.Replace(wakeBody(), `"op":"send"`, `"op":"send","port":9`, 1),
		strings.Replace(wakeBody(), `"network":"192.168.0.0/24"`, `"network":"192.168.0.2/24"`, 1), strings.Replace(wakeBody(), "192.168.0.0/24", "0.0.0.0/0", 1),
		strings.Replace(wakeBody(), "192.168.0.0/24", "192.168.0.0/31", 1), strings.Replace(wakeBody(), "192.168.0.0/24", "fd00::/64", 1), strings.Replace(wakeBody(), `"id":"1234567890abcdef1234567890abcdef"`, `"id":"bad"`, 1)} {
		if fileCall(h, []byte("first"), "POST", "/v1/wake", bad).Code != 400 {
			t.Fatal("bad request", bad)
		}
	}
	if f.reads != 0 || f.sends != 0 {
		t.Fatal("invalid request reached worker")
	}
}
func TestWakeHelperUsesOnlyItsCurrentPhysicalLAN(t *testing.T) {
	f, h := newWakeFixture(t)
	response := fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody())
	var result wakeResult
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || response.Code != 200 || result.State != "sent" || result.Sent != 3 || result.WakeVerified || f.sends != 1 {
		t.Fatal(response.Code, response.Body.String())
	}
	// A helper need not itself support hardware wake to send a magic packet.
	if f.state.Adapters[0].Configuration != "unknown" {
		t.Fatal("fixture lost unknown wake capability")
	}
	for _, kind := range []string{"disconnected", "different-subnet", "different-prefix", "not-physical", "stale-source"} {
		t.Run(kind, func(t *testing.T) {
			f, h := newWakeFixture(t)
			switch kind {
			case "disconnected":
				f.state.Adapters[0].Connected = false
			case "different-subnet":
				f.state.Adapters[0].Addresses[0].Address = "192.168.1.2"
			case "different-prefix":
				f.state.Adapters[0].Addresses[0].Prefix = 16
			case "not-physical":
				f.state.Adapters[0].Kind = "vpn"
			case "stale-source":
				f.state.Adapters[0].Addresses = nil
			}
			code := fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code
			if (code != 409 && code != 503) || f.sends != 0 {
				t.Fatal("unrelated LAN sent", code)
			}
		})
	}
}
func TestWakeStatusPreservesUnknownAndNeverClaimsVerified(t *testing.T) {
	f, h := newWakeFixture(t)
	response := fileCall(h, []byte("first"), "POST", "/v1/wake", `{"op":"status"}`)
	var state wakeInventory
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.WakeVerified || state.Adapters[0].Configuration != "unknown" || f.sends != 0 {
		t.Fatal(response.Body.String())
	}
	for _, kind := range []string{"verified", "false-ready", "zero-mac", "duplicate-id", "loopback"} {
		t.Run(kind, func(t *testing.T) {
			f, h := newWakeFixture(t)
			switch kind {
			case "verified":
				f.state.WakeVerified = true
			case "false-ready":
				f.state.Adapters[0].Configuration = "configured"
			case "zero-mac":
				f.state.Adapters[0].MAC = "00:00:00:00:00:00"
			case "duplicate-id":
				f.state.Adapters = append(f.state.Adapters, f.state.Adapters[0])
			case "loopback":
				f.state.Adapters[0].Addresses[0].Address = "127.0.0.1"
			}
			if fileCall(h, []byte("first"), "POST", "/v1/wake", `{"op":"status"}`).Code != 503 {
				t.Fatal("untrusted inventory accepted")
			}
		})
	}
}
func TestWakeRetryReceiptsAreOwnerBound(t *testing.T) {
	f, h := newWakeFixture(t)
	call := func(peer, body string) int { return fileCall(h, []byte(peer), "POST", "/v1/wake", body).Code }
	if call("first", wakeBody()) != 200 || call("first", wakeBody()) != 200 || f.sends != 1 || f.reads != 1 {
		t.Fatal("lost acknowledgment replayed burst")
	}
	if call("first", strings.Replace(wakeBody(), wakeTestMAC, "02:11:22:33:44:66", 1)) != 409 || f.sends != 1 {
		t.Fatal("same ID retargeted")
	}
	if call("second", wakeBody()) != 200 || f.sends != 2 {
		t.Fatal("another owner inherited receipt")
	}
	f.now = f.now.Add(2 * time.Minute)
	if call("first", wakeBody()) != 200 || f.sends != 3 {
		t.Fatal("expired receipt never released")
	}
}
func TestWakeRateAndReceiptBounds(t *testing.T) {
	f, h := newWakeFixture(t)
	if fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code != 200 {
		t.Fatal("start")
	}
	next := strings.Replace(wakeBody(), privacyTestLease, strings.Repeat("a", 32), 1)
	if fileCall(h, []byte("first"), "POST", "/v1/wake", next).Code != 429 || f.sends != 1 {
		t.Fatal("owner rate limit")
	}
	f.now = f.now.Add(10 * time.Second)
	if fileCall(h, []byte("first"), "POST", "/v1/wake", next).Code != 200 || f.sends != 2 {
		t.Fatal("rate window")
	}
	f, h = newWakeFixture(t)
	f.control.global = make([]time.Time, 60)
	for i := range f.control.global {
		f.control.global[i] = f.now
	}
	if fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code != 429 || f.sends != 0 {
		t.Fatal("global rate limit")
	}
}
func TestWakeRevocationDuringDiscoveryPreventsDisclosureAndSending(t *testing.T) {
	for _, body := range []string{`{"op":"status"}`, wakeBody()} {
		f, h := newWakeFixture(t)
		f.onRead = func() { filePairing(t, f.control.clients, []byte("second")) }
		response := fileCall(h, []byte("first"), "POST", "/v1/wake", body)
		if response.Code != 403 || f.sends != 0 || strings.Contains(response.Body.String(), "192.168.") {
			t.Fatal("revocation ignored")
		}
	}
}
func TestWakePartialAndFailedSendsDoNotClaimHardwareSuccess(t *testing.T) {
	for _, sent := range []int{0, 1} {
		f, h := newWakeFixture(t)
		f.control.send = func(context.Context, []wakeRoute, []byte, func() bool) (int, error) {
			f.sends++
			return sent, errors.New("route changed")
		}
		response := fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody())
		var state wakeResult
		if json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Sent != sent || state.WakeVerified || state.OK != (sent > 0) {
			t.Fatal(response.Body.String())
		}
		fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody())
		if f.sends != 1 {
			t.Fatal("failed or partial send replayed")
		}
	}
}
func TestWakeCanceledOrRevokedTransportSendsNothing(t *testing.T) {
	routes := []wakeRoute{{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("127.0.0.1")}}
	packet, _ := wakePayload(wakeTestMAC)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if n, err := sendWake(ctx, routes, packet, func() bool { return true }); n != 0 || err == nil {
		t.Fatal("canceled send")
	}
	if n, err := sendWake(context.Background(), routes, packet, func() bool { return false }); n != 0 || err == nil {
		t.Fatal("revoked send")
	}
}
func TestWakeActualUDPContainsOnlyMagicPacket(t *testing.T) {
	receiver, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	_ = receiver.SetReadDeadline(time.Now().Add(2 * time.Second))
	packet, _ := wakePayload(wakeTestMAC)
	if err = writeWakeDatagram(netip.MustParseAddr("127.0.0.1"), receiver.LocalAddr().(*net.UDPAddr), packet); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1024)
	count, source, err := receiver.ReadFromUDP(buffer)
	if err != nil || !source.IP.IsLoopback() || count != 102 || !bytes.Equal(packet, buffer[:count]) {
		t.Fatal("unexpected wire packet", count, source, err)
	}
}
func TestWakeNativeWorkerStatusAndEOF(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_WAKE_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_WAKE_TEST_WORKER for native read-only discovery")
	}
	p := &probe{executable: executable, argument: "--wake-probe", maxOutput: 65536, timeout: 8 * time.Second}
	defer p.stop()
	control := &wakeControl{read: p.read}
	inventory, err := control.inventory()
	if err != nil || !validWakeInventory(inventory) {
		t.Fatal(inventory, err)
	}
	command := p.cmd
	p.stop()
	if command.ProcessState == nil || !command.ProcessState.Success() {
		t.Fatal("worker did not exit on EOF")
	}
	t.Log("Read physical adapter settings; no setting changes or LAN packets")
}

func TestWakeRealMutualTLSRevocationAndNativeDiscovery(t *testing.T) {
	executable := os.Getenv("CLIPRELAY_WAKE_TEST_WORKER")
	if executable == "" {
		t.Skip("set CLIPRELAY_WAKE_TEST_WORKER for read-only native discovery")
	}
	worker := &probe{executable: executable, argument: "--wake-probe", maxOutput: 65536, timeout: 8 * time.Second}
	defer worker.stop()
	clients := filepath.Join(t.TempDir(), "clients.json")
	clientCert := fileTestCertificate(t)
	filePairing(t, clients, clientCert.Certificate[0])
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	host := seed.TLS.Certificates[0]
	seed.Close()
	control := &wakeControl{clients: clients, read: worker.read, now: time.Now}
	server := httptest.NewUnstartedServer(control.handler(http.NotFoundHandler()))
	server.TLS = controlTLSConfig(host, clients)
	server.StartTLS()
	defer server.Close()
	// httptest's trust pool validates this exact local test server certificate.
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.Certificates = []tls.Certificate{clientCert}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	defer transport.CloseIdleConnections()
	request := func() *http.Response {
		t.Helper()
		response, err := client.Post(server.URL+"/v1/wake", "application/json", strings.NewReader(`{"op":"status"}`))
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := request()
	var state wakeInventory
	err := json.NewDecoder(response.Body).Decode(&state)
	response.Body.Close()
	if response.StatusCode != 200 || err != nil || !validWakeInventory(state) {
		t.Fatal(response.StatusCode, state, err)
	}
	// Revocation must reject subsequent requests on an already authenticated TLS connection.
	filePairing(t, clients, []byte("replacement"))
	response = request()
	defer response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("revoked keepalive peer read inventory", response.StatusCode)
	}
	t.Log("Real TLS and native inventory verified; no wake packets or power changes")
}

func TestWakeMacHelperPreservesAuthorizationAndUnknownHardware(t *testing.T) {
	f, h := newWakeFixture(t)
	f.state.Platform = "macos"
	f.state.Adapters[0].MagicPacket = "unknown"
	f.state.Adapters[0].PowerManagement = "unknown"
	f.state.Adapters[0].WakeArmed = "unknown"
	if fileCall(h, []byte("unknown"), "POST", "/v1/wake", wakeBody()).Code != 403 || f.reads != 0 {
		t.Fatal("unpaired Mac helper disclosure")
	}
	if fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code != 200 || f.sends != 1 {
		t.Fatal("Mac helper unavailable")
	}
	if fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code != 200 || f.sends != 1 {
		t.Fatal("Mac replay resent datagrams")
	}
	filePairing(t, f.control.clients, []byte("second"))
	if fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody()).Code != 403 || f.sends != 1 {
		t.Fatal("revoked Mac helper owner")
	}
	for _, platform := range []string{"darwin", "linux", "MACOS", ""} {
		f.state.Platform = platform
		if validWakeInventory(f.state) {
			t.Fatal("unsupported platform accepted", platform)
		}
	}
}

// The paired API selects its Mac LAN route normally; only the final datagram
// destination is redirected to an owned loopback receiver. Never a LAN broadcast.
func TestWakeMacAuthenticatedUDPReceipt(t *testing.T) {
	f, h := newWakeFixture(t)
	f.state.Platform = "macos"
	receiver, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	original := f.control.send
	f.control.send = func(ctx context.Context, routes []wakeRoute, payload []byte, allowed func() bool) (int, error) {
		if _, err := original(ctx, routes, payload, allowed); err != nil {
			return 0, err
		}
		if err := writeWakeDatagram(netip.MustParseAddr("127.0.0.1"), receiver.LocalAddr().(*net.UDPAddr), payload); err != nil {
			return 0, err
		}
		return 1, nil
	}
	for i := 0; i < 2; i++ {
		response := fileCall(h, []byte("first"), "POST", "/v1/wake", wakeBody())
		var result wakeResult
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Sent != 1 || result.WakeVerified {
			t.Fatal(response.Body.String())
		}
	}
	if f.sends != 1 {
		t.Fatal("duplicate datagram after replay")
	}
	_ = receiver.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 103)
	n, _, err := receiver.ReadFromUDP(buffer)
	expected, _ := wakePayload(wakeTestMAC)
	if err != nil || !bytes.Equal(buffer[:n], expected) {
		t.Fatal("wrong controlled datagram", n, err)
	}
}
