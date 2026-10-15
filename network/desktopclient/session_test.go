package desktopclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeNode struct {
	gate, closed chan struct{}
	once         sync.Once
	peers        string
	forwarded    atomic.Bool
	failure      error
}

func (n *fakeNode) Start() (string, error) {
	select {
	case <-n.gate:
		return "[]", n.failure
	case <-n.closed:
		return "", errors.New("stopped")
	}
}
func (n *fakeNode) SetPeers(peers string) error { n.peers = peers; return nil }
func (n *fakeNode) ForwardLocal(peer string) (int, error) {
	if peer != "100.64.0.2" {
		return 0, errors.New("wrong peer")
	}
	n.forwarded.Store(true)
	return 32000, nil
}
func (n *fakeNode) BridgesReady() bool { return n.forwarded.Load() }
func (n *fakeNode) PeerPaths() (string, error) {
	return `{"100.64.0.2":"relay","100.64.0.3":"secret-unrelated-peer"}`, nil
}
func (n *fakeNode) Close() error { n.once.Do(func() { close(n.closed) }); return nil }

type fixture struct {
	writer *io.PipeWriter
	lines  chan string
	done   chan error
	node   *fakeNode
}

func startFixture(t *testing.T) *fixture {
	t.Helper()
	input, writer := io.Pipe()
	output, sink := io.Pipe()
	f := &fixture{writer: writer, lines: make(chan string, 10), done: make(chan error, 1), node: &fakeNode{gate: make(chan struct{}), closed: make(chan struct{})}}
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			f.lines <- scanner.Text()
		}
		close(f.lines)
	}()
	go func() {
		f.done <- Run(context.Background(), input, sink, func(init Init) (Driver, error) { return f.node, nil })
		sink.Close()
	}()
	t.Cleanup(func() { writer.Close(); input.Close(); output.Close(); sink.Close(); f.node.Close() })
	return f
}
func (f *fixture) line(t *testing.T) string {
	t.Helper()
	select {
	case line := <-f.lines:
		return line
	case <-time.After(3 * time.Second):
		t.Fatal("no bounded protocol response")
		return ""
	}
}
func (f *fixture) finished(t *testing.T) error {
	t.Helper()
	select {
	case err := <-f.done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("owner loss did not close the channel")
		return nil
	}
}

const initialization = `{"version":1,"controlUrl":"https://control.invalid","hostname":"cr-012345678901234567890123","authKey":"sensitive-one-use-key","peerIP":"100.64.0.2"}`

func TestOwnerLeaseAndSanitizedStatus(t *testing.T) {
	f := startFixture(t)
	io.WriteString(f.writer, initialization+"\n")
	if got := f.line(t); !strings.Contains(got, `"ready":false`) || strings.Contains(got, "sensitive") {
		t.Fatal(got)
	}
	close(f.node.gate)
	var state map[string]any
	json.Unmarshal([]byte(f.line(t)), &state)
	if state["ready"] != true || state["port"] != float64(32000) || state["path"] != "relay" || len(state) != 4 {
		t.Fatal(state)
	}
	if f.node.peers != `["100.64.0.2"]` {
		t.Fatal("node was not restricted to the approved computer")
	}
	f.writer.Close()
	if err := f.finished(t); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.node.closed:
	default:
		t.Fatal("Run returned before closing network sockets")
	}
}

func TestOwnerLossInterruptsRegistration(t *testing.T) {
	f := startFixture(t)
	io.WriteString(f.writer, initialization+"\n")
	f.line(t)
	f.writer.Close()
	if err := f.finished(t); err != nil {
		t.Fatal(err)
	}
	if f.node.forwarded.Load() {
		t.Fatal("a channel opened after its owner disappeared")
	}
}

func TestFailureDoesNotExposeProviderCredentials(t *testing.T) {
	f := startFixture(t)
	f.node.failure = errors.New("https://provider.invalid/?authKey=SECRET")
	io.WriteString(f.writer, initialization+"\n")
	f.line(t)
	close(f.node.gate)
	if err := f.finished(t); err == nil || err.Error() != "CONNECTION_FAILED" {
		t.Fatal(err)
	}
}

func TestInvalidInitializationNeverCreatesNode(t *testing.T) {
	for _, input := range []string{
		strings.Replace(initialization, `"version":1`, `"version":2`, 1),
		strings.Replace(initialization, "https://control.invalid", "http://control.invalid", 1),
		strings.Replace(initialization, "https://control.invalid", "https://user:pass@control.invalid", 1),
		strings.Replace(initialization, "100.64.0.2", "192.168.1.5", 1),
		strings.Replace(initialization, "100.64.0.2", "127.0.0.1", 1),
		strings.Replace(initialization, `"version":1`, `"unapprovedSetting":true,"version":1`, 1),
		strings.Replace(initialization, "sensitive-one-use-key", strings.Repeat("x", 4097), 1),
		initialization + `{}`,
	} {
		called := false
		Run(context.Background(), strings.NewReader(input+"\n"), io.Discard, func(Init) (Driver, error) { called = true; return nil, errors.New("unexpected") })
		if called {
			t.Fatal("invalid request reached node factory")
		}
	}
}

func TestUnknownAndOversizedCommandsCloseChannel(t *testing.T) {
	for _, command := range []string{`{"action":"expose"}`, `{"action":"status","credential":"secret"}`, strings.Repeat("x", 20000)} {
		f := startFixture(t)
		io.WriteString(f.writer, initialization+"\n")
		f.line(t)
		go io.WriteString(f.writer, command+"\n")
		if err := f.finished(t); err == nil || err.Error() != "INVALID_COMMAND" {
			t.Fatal("malformed command was not reported", err)
		}
		select {
		case <-f.node.closed:
		default:
			t.Fatal("invalid command left network running")
		}
	}
}

func TestShutdownAndWriterFailureReleaseNode(t *testing.T) {
	f := startFixture(t)
	io.WriteString(f.writer, initialization+"\n")
	f.line(t)
	io.WriteString(f.writer, "{\"action\":\"shutdown\"}\n")
	if err := f.finished(t); err != nil {
		t.Fatal(err)
	}
	node := &fakeNode{gate: make(chan struct{}), closed: make(chan struct{})}
	input, writer := io.Pipe()
	defer input.Close()
	defer writer.Close()
	done := make(chan struct{})
	go func() {
		Run(context.Background(), input, failingWriter{}, func(Init) (Driver, error) { return node, nil })
		close(done)
	}()
	io.WriteString(writer, initialization+"\n")
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("failed output pipe leaked the node")
	}
	select {
	case <-node.closed:
	default:
		t.Fatal("failed output left the network node alive")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
