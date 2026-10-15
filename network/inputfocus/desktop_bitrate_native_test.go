package inputfocus

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A bounded local fixture uses the production paired handlers and engine pinning.
// The test driver supplies temporary paths/password only over stdin.
func TestDesktopBitrateNativeFixture(t *testing.T) {
	if os.Getenv("CLIPRELAY_DESKTOP_BITRATE_FIXTURE") != "1" {
		t.Skip("isolated native video fixture only")
	}
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		t.Fatal("missing fixture configuration")
	}
	var config struct {
		Directory, Password string
		Port                int
	}
	if json.Unmarshal(scanner.Bytes(), &config) != nil || config.Port < 1029 || config.Port > 65514 || len(config.Password) < 32 || !filepath.IsAbs(config.Directory) {
		t.Fatal("invalid fixture configuration")
	}
	host, err := tls.LoadX509KeyPair(filepath.Join(config.Directory, "cacert.pem"), filepath.Join(config.Directory, "cakey.pem"))
	if err != nil {
		t.Fatal("fixture certificate unavailable")
	}
	clients := filepath.Join(config.Directory, "clients.json")
	endpoint := fmt.Sprintf("https://127.0.0.1:%d", config.Port+1)
	displays := func(ctx context.Context, refresh bool, selection *displaySelection) (displayState, error) {
		return requestEngineDisplay(ctx, endpoint, config.Password, host.Certificate[0], refresh, selection)
	}
	rates := func(ctx context.Context, owner string, selection *bitrateSelection) (bitrateState, error) {
		return requestEngineBitrate(ctx, endpoint, config.Password, host.Certificate[0], owner, selection)
	}
	inputs := func(ctx context.Context) (inputState, error) {
		return requestEngineInput(ctx, endpoint, config.Password, host.Certificate[0])
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", config.Port+2))
	if err != nil {
		t.Fatal("fixture port unavailable")
	}
	server := &http.Server{Handler: withInputState(withDisplays(withBitrate(http.NotFoundHandler(), clients, rates), clients, displays), clients, inputs), TLSConfig: controlTLSConfig(host, clients), ReadHeaderTimeout: 3 * time.Second}
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	defer server.Close()
	fmt.Println(`{"type":"control-ready"}`)
	for scanner.Scan() {
	}
	server.Close()
	if err := <-finished; err != http.ErrServerClosed {
		t.Fatal("fixture shutdown failed")
	}
}
