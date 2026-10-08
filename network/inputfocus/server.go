// Package inputfocus exposes focus/app metadata and explicit image clipboard writes
// to paired clients. It never reads control values, labels, text or clipboard data.
package inputfocus

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type State struct {
	Supported bool   `json:"supported"`
	Editable  bool   `json:"editable"`
	FocusID   string `json:"focusId"`
	Targeted  bool   `json:"targeted,omitempty"`
}

type Application struct {
	Supported bool   `json:"supported"`
	AppID     string `json:"appId"`
}

// Check revocation on every request, including reused TLS connections.
func paired(path string, certificate []byte) bool {
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 4*1024*1024 || len(certificate) == 0 {
		return false
	}
	var db struct {
		Root struct {
			Devices []struct {
				Cert    string `json:"cert"`
				Enabled any    `json:"enabled"`
			} `json:"named_devices"`
		} `json:"root"`
	}
	if json.Unmarshal(b, &db) != nil {
		return false
	}
	for _, device := range db.Root.Devices {
		if device.Enabled == false || device.Enabled == "false" || device.Enabled == "0" {
			continue
		}
		block, _ := pem.Decode([]byte(device.Cert))
		if block != nil && block.Type == "CERTIFICATE" && bytes.Equal(block.Bytes, certificate) {
			return true
		}
	}
	return false
}

type probe struct {
	mu         sync.Mutex
	executable string
	argument   string
	cmd        *exec.Cmd
	in         io.WriteCloser
	out        *bufio.Reader
}

func (p *probe) stop() {
	if p.cmd != nil {
		p.in.Close()
		// Let the voice helper cancel recording and restore the microphone on stdin EOF.
		done := make(chan struct{})
		go func() { p.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(3500 * time.Millisecond):
			p.cmd.Process.Kill()
			<-done
		}
		p.cmd = nil
	}
}

func (p *probe) read(command string) (json.RawMessage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil {
		argument := p.argument
		if argument == "" {
			argument = "--focus-probe"
		}
		cmd := exec.Command(p.executable, argument)
		quietProcess(cmd)
		in, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			in.Close()
			return nil, err
		}
		if err = cmd.Start(); err != nil {
			in.Close()
			out.Close()
			return nil, err
		}
		p.cmd, p.in, p.out = cmd, in, bufio.NewReaderSize(out, 4096)
	}
	// A hung accessibility provider cannot stall streaming or retain workers.
	// The service Job owns this entire process tree.
	result := make(chan []byte, 1)
	timeout := 1200 * time.Millisecond
	if strings.HasPrefix(command, "voice-") {
		timeout = 8 * time.Second
	}
	if strings.HasPrefix(command, "image:") {
		timeout = 8 * time.Second
	}
	go func() {
		if _, err := io.WriteString(p.in, command+"\n"); err != nil {
			result <- nil
			return
		}
		b, err := p.out.ReadSlice('\n')
		if err != nil {
			result <- nil
			return
		}
		result <- append([]byte(nil), b...)
	}()
	select {
	case b := <-result:
		if len(b) == 0 || len(b) > 1024 || !json.Valid(b) {
			p.stop()
			return nil, errors.New("focus unavailable")
		}
		return json.RawMessage(b), nil
	case <-time.After(timeout):
		p.stop()
		<-result
		return nil, errors.New("focus timeout")
	}
}

func handler(clients string, read func(string) (json.RawMessage, error), voiceRead ...func(string) (json.RawMessage, error)) http.Handler {
	busy := make(chan struct{}, 1)
	voiceProvider := read
	if len(voiceRead) != 0 {
		voiceProvider = voiceRead[0]
	}
	voice := &voiceHandler{read: voiceProvider, now: time.Now}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || !paired(clients, r.TLS.PeerCertificates[0].Raw) {
			http.Error(w, "unpaired", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/voice/") {
			voice.serve(w, r, clients)
			return
		}
		command := "focus"
		if r.URL.Path == "/v1/foreground-app" {
			command = "app"
		}
		upload := r.Method == "POST" && r.URL.Path == "/v1/clipboard-image"
		if !upload && (r.Method != "GET" || (r.URL.Path != "/v1/input-focus" && r.URL.Path != "/v1/foreground-app")) {
			http.NotFound(w, r)
			return
		}
		if command == "focus" && !upload && r.URL.RawQuery != "" {
			query, err := url.ParseQuery(r.URL.RawQuery)
			if err != nil || len(query) != 2 || len(query["x"]) != 1 || len(query["y"]) != 1 {
				http.Error(w, "invalid tap", http.StatusBadRequest)
				return
			}
			x, xerr := strconv.ParseFloat(query.Get("x"), 64)
			y, yerr := strconv.ParseFloat(query.Get("y"), 64)
			if xerr != nil || yerr != nil || math.IsNaN(x) || math.IsNaN(y) || x < 0 || x > 1 || y < 0 || y > 1 {
				http.Error(w, "invalid tap", http.StatusBadRequest)
				return
			}
			command = "focus:" + strconv.FormatFloat(x, 'g', -1, 64) + ":" + strconv.FormatFloat(y, 'g', -1, 64)
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "busy", http.StatusTooManyRequests)
			return
		}
		if upload {
			receiveImage(w, r, clients, read)
			return
		}
		data, err := read(command)
		if err != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		// Decode into a fixed schema so no extra provider fields can be exposed.
		var state any
		if command == "app" {
			var app Application
			if json.Unmarshal(data, &app) != nil {
				http.Error(w, "invalid", 503)
				return
			}
			switch app.AppID {
			case "general", "orca", "chatgpt", "stardew", "plateup":
			default:
				app = Application{}
			}
			state = app
		} else {
			var focus State
			if json.Unmarshal(data, &focus) != nil || len(focus.FocusID) > 128 {
				http.Error(w, "invalid", 503)
				return
			}
			state = focus
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(state)
	})
}

const maxImageBytes = 8 * 1024 * 1024

func receiveImage(w http.ResponseWriter, r *http.Request, clients string, read func(string) (json.RawMessage, error)) {
	// Same paired TLS identity as the stream; only a bounded PNG clipboard write.
	if r.Header.Get("Content-Type") != "image/png" {
		http.Error(w, "PNG required", 415)
		return
	}
	if r.ContentLength > maxImageBytes {
		http.Error(w, "too large", 413)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(40 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(50 * time.Second))
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImageBytes))
	if err != nil {
		http.Error(w, "invalid size", 413)
		return
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 ||
		int64(config.Width)*int64(config.Height) > 6000000 {
		http.Error(w, "invalid image", 400)
		return
	}
	// An authorization can be revoked while the body is arriving.
	if !paired(clients, r.TLS.PeerCertificates[0].Raw) {
		http.Error(w, "unpaired", 403)
		return
	}
	result, err := read("image:" + base64.StdEncoding.EncodeToString(data))
	var status struct {
		OK bool `json:"ok"`
	}
	if err != nil || json.Unmarshal(result, &status) != nil || !status.OK {
		http.Error(w, "clipboard unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "width": config.Width, "height": config.Height})
}

func Serve(ctx context.Context, dir, executable string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "cacert.pem"), filepath.Join(dir, "cakey.pem"))
	if err != nil {
		return err
	}
	clients := filepath.Join(dir, "clients.json")
	p := &probe{executable: executable}
	defer p.stop()
	voice := &probe{executable: executable, argument: "--voice-probe"}
	defer voice.stop()
	// Start the user worker on host startup so an interrupted microphone switch
	// is recovered before the next phone dictation. This does not start recording.
	_, _ = voice.read("voice-status")
	server := &http.Server{
		Addr: ":48791", Handler: handler(clients, p.read, voice.read),
		ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 3 * time.Second,
		WriteTimeout: 3 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096,
		ErrorLog: log.New(io.Discard, "", 0),
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert},
			ClientAuth: tls.RequireAnyClientCert,
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) != 1 || !paired(clients, raw[0]) {
					return errors.New("unpaired")
				}
				return nil
			}},
	}
	go func() { _ = serveLANPairing(ctx, dir, cert) }()
	go func() { _ = serveLANDiscovery(ctx) }()
	go func() { <-ctx.Done(); server.Close() }()
	return server.ListenAndServeTLS("", "")
}
