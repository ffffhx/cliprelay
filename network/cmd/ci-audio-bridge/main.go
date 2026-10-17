// Disposable CI only. Never install this entry point or publish its identities.
// The private key stays under RUNNER_TEMP; stdout contains public identity data
// and fixed status fields only. EOF/parent exit/deadline closes every socket.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"cliprelay/network/internal/ciaudiobridge"
	"cliprelay/network/transport"
)

// Only the synthetic echo and control endpoints for this transport experiment.
// Native host ports will require an explicit separate test mode when integrated.
var tcpPorts = []int{48789, 48830}
var udpPorts = []int{48798}
var runID = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var tunnelName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.trycloudflare\.com$`)

type initialization struct {
	Version         int    `json:"version"`
	Role            string `json:"role"`
	Directory       string `json:"directory"`
	PeerCertificate string `json:"peerCertificate"`
	URL             string `json:"url,omitempty"`
}

func allowedRoot() (string, error) {
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("GITHUB_REPOSITORY") != "ffffhx/cliprelay" || !runID.MatchString(os.Getenv("GITHUB_RUN_ID")) {
		return "", errors.New("CI_REQUIRED")
	}
	root, err := filepath.EvalSymlinks(os.Getenv("RUNNER_TEMP"))
	if err != nil || !filepath.IsAbs(root) || filepath.Dir(root) == root {
		return "", errors.New("RUNNER_ROOT_INVALID")
	}
	return root, nil
}

func directory(root, requested string) (string, error) {
	resolved, err := filepath.EvalSymlinks(requested)
	if err != nil || resolved != filepath.Clean(requested) || filepath.Dir(resolved) != root || !strings.HasPrefix(filepath.Base(resolved), "cliprelay-audio-bridge-") {
		return "", errors.New("IDENTITY_DIRECTORY_INVALID")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return "", errors.New("IDENTITY_DIRECTORY_INVALID")
	}
	return resolved, nil
}

func writePrivate(name string, data []byte) error {
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func readPrivate(dir, name string) ([]byte, error) {
	file := filepath.Join(dir, name)
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return nil, errors.New("IDENTITY_FILE_INVALID")
	}
	return os.ReadFile(file)
}

func certHash(data []byte) string {
	block, _ := pem.Decode(data)
	if block == nil {
		return ""
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:])
}

func emit(value any) { _ = json.NewEncoder(os.Stdout).Encode(value) }

func createIdentity(root string) error {
	dir, err := os.MkdirTemp(root, "cliprelay-audio-bridge-")
	if err != nil {
		return errors.New("IDENTITY_CREATE_FAILED")
	}
	cert, key, err := ciaudiobridge.Identity()
	if err != nil {
		return errors.New("IDENTITY_CREATE_FAILED")
	}
	if writePrivate(filepath.Join(dir, "certificate.pem"), cert) != nil || writePrivate(filepath.Join(dir, "private.pem"), key) != nil {
		return errors.New("IDENTITY_WRITE_FAILED")
	}
	for i := range key {
		key[i] = 0
	}
	emit(map[string]any{"event": "identity", "version": 1, "directory": dir, "certificate": string(cert), "certificateSha256": certHash(cert)})
	return nil
}

func targets() []ciaudiobridge.Target {
	var result []ciaudiobridge.Target
	for _, port := range tcpPorts {
		result = append(result, ciaudiobridge.Target{Network: "tcp", Port: port})
	}
	for _, port := range udpPorts {
		result = append(result, ciaudiobridge.Target{Network: "udp", Port: port})
	}
	return result
}

func forward(ctx context.Context, client ciaudiobridge.Client, ready chan<- error) error {
	var listeners []net.Listener
	var packets []net.PacketConn
	defer func() {
		for _, v := range listeners {
			v.Close()
		}
		for _, v := range packets {
			v.Close()
		}
	}()
	for _, port := range tcpPorts {
		listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			ready <- errors.New("FORWARD_BIND_FAILED")
			return err
		}
		listeners = append(listeners, listener)
	}
	for _, port := range udpPorts {
		packet, err := net.ListenPacket("udp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			ready <- errors.New("FORWARD_BIND_FAILED")
			return err
		}
		packets = append(packets, packet)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	results := make(chan error, len(listeners)+len(packets))
	allow := func(source net.Addr) bool {
		switch a := source.(type) {
		case *net.TCPAddr:
			return a.IP.IsLoopback()
		case *net.UDPAddr:
			return a.IP.IsLoopback()
		}
		return false
	}
	for _, listener := range listeners {
		workers.Add(1)
		go func(l net.Listener) {
			defer workers.Done()
			results <- transport.TCP(ctx, l, client.DialContext, l.Addr().String(), allow)
			cancel()
		}(listener)
	}
	for _, packet := range packets {
		workers.Add(1)
		go func(p net.PacketConn) {
			defer workers.Done()
			results <- transport.UDP(ctx, p, client.DialContext, p.LocalAddr().String(), allow)
			cancel()
		}(packet)
	}
	ready <- nil
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			return errors.New("FORWARD_FAILED")
		}
	}
	return nil
}

func serve(root string) error {
	owner := os.Getppid()
	if owner <= 1 {
		return errors.New("OWNER_REQUIRED")
	}
	reader := bufio.NewReaderSize(os.Stdin, 16384)
	initializationDeadline := time.AfterFunc(5*time.Second, func() { emit(map[string]any{"event": "error", "code": "INITIALIZATION_TIMEOUT"}); os.Exit(2) })
	line, err := reader.ReadSlice('\n')
	initializationDeadline.Stop()
	if err != nil || len(line) > 16384 {
		return errors.New("INITIALIZATION_INVALID")
	}
	var init initialization
	decode := json.NewDecoder(bytes.NewReader(line))
	decode.DisallowUnknownFields()
	if decode.Decode(&init) != nil || init.Version != 1 || (init.Role != "host" && init.Role != "viewer") || len(init.PeerCertificate) > 4096 {
		return errors.New("INITIALIZATION_INVALID")
	}
	var extra any
	if decode.Decode(&extra) != io.EOF {
		return errors.New("INITIALIZATION_INVALID")
	}
	dir, err := directory(root, init.Directory)
	if err != nil {
		return err
	}
	cert, err := readPrivate(dir, "certificate.pem")
	if err != nil {
		return err
	}
	key, err := readPrivate(dir, "private.pem")
	if err != nil {
		return err
	}
	own, err := tls.X509KeyPair(cert, key)
	for i := range key {
		key[i] = 0
	}
	if err != nil {
		return errors.New("IDENTITY_INVALID")
	}
	config, err := ciaudiobridge.TLSConfig(own, []byte(init.PeerCertificate), init.Role == "host")
	if err != nil {
		return errors.New("PEER_INVALID")
	}
	if init.Role == "host" && init.URL != "" {
		return errors.New("ROUTE_INVALID")
	}
	if init.Role == "viewer" {
		u, err := url.Parse(init.URL)
		if err != nil || u.Scheme != "wss" || u.User != nil || u.Path != "/bridge" || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" || !tunnelName.MatchString(u.Hostname()) {
			return errors.New("ROUTE_INVALID")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	ctx, signals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer signals()
	status := map[string]any{"event": "ready", "version": 1, "role": init.Role, "certificateSha256": certHash(cert), "peerCertificateSha256": certHash([]byte(init.PeerCertificate))}
	done := make(chan error, 1)
	var server *ciaudiobridge.Server
	if init.Role == "host" {
		server, err = ciaudiobridge.NewServer(config, targets())
		if err != nil {
			return errors.New("SERVER_INVALID")
		}
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return errors.New("SERVER_BIND_FAILED")
		}
		status["address"] = listener.Addr().String()
		go func() { done <- server.Serve(ctx, listener) }()
	} else {
		ready := make(chan error, 1)
		client := ciaudiobridge.Client{Context: ctx, URL: init.URL, TLS: config}
		go func() { done <- forward(ctx, client, ready) }()
		if err = <-ready; err != nil {
			return err
		}
		status["tcpPorts"] = tcpPorts
		status["udpPorts"] = udpPorts
	}
	emit(status)
	commands := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 128), 128)
		for scanner.Scan() {
			if scanner.Text() != "state" {
				commands <- errors.New("COMMAND_INVALID")
				return
			}
			state := map[string]any{"event": "state"}
			if server != nil {
				state["counters"] = server.Counters()
			}
			emit(state)
		}
		if scanner.Err() != nil {
			commands <- errors.New("COMMAND_INVALID")
		} else {
			commands <- nil
		}
	}()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var result error
loop:
	for {
		select {
		case result = <-commands:
			break loop
		case result = <-done:
			done = nil
			break loop
		case <-ctx.Done():
			result = errors.New("LIFETIME_ENDED")
			break loop
		case <-ticker.C:
			if os.Getppid() != owner {
				result = errors.New("OWNER_EXITED")
				break loop
			}
		}
	}
	cancel()
	if done != nil {
		if closeErr := <-done; result == nil {
			result = closeErr
		}
	}
	closed := map[string]any{"event": "closed", "listenersClosed": true}
	if server != nil {
		closed["counters"] = server.Counters()
	}
	emit(closed)
	return result
}

func main() {
	root, err := allowedRoot()
	if err == nil {
		if len(os.Args) != 2 {
			err = errors.New("MODE_INVALID")
		} else if os.Args[1] == "init" {
			err = createIdentity(root)
		} else if os.Args[1] == "serve" {
			err = serve(root)
		} else {
			err = errors.New("MODE_INVALID")
		}
	}
	if err != nil {
		emit(map[string]any{"event": "error", "code": err.Error()})
		os.Exit(2)
	}
}
