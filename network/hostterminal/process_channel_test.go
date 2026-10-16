package hostterminal

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

type channelProcess struct {
	mu     sync.Mutex
	state  ProcessState
	done   chan struct{}
	closed bool
	output func([]byte)
	writes [][]byte
	size   [2]int
}

func (p *channelProcess) Queue(data []byte, sequence int64, paste bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.writes = append(p.writes, append([]byte(nil), data...))
	p.state.Written = sequence
	return true
}
func (p *channelProcess) Resize(c, r int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.size = [2]int{c, r}
	return nil
}
func (p *channelProcess) Status() ProcessState { p.mu.Lock(); defer p.mu.Unlock(); return p.state }
func (p *channelProcess) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		p.closed = true
		p.state.Exited = true
		close(p.done)
	}
}
func (p *channelProcess) Done() <-chan struct{} { return p.done }

func TestProcessChannelStrictFrames(t *testing.T) {
	for _, raw := range []string{`{"op":"write","sequence":1,"data":"eA=="}`, `{"op":"paste","sequence":2,"data":"eA=="}`, `{"op":"resize","control":1,"columns":80,"rows":24}`} {
		if _, err := decodeProcessCommand([]byte(raw)); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{`{"op":"write","sequence":1,"data":"eA==","data":"eQ=="}`, `{"op":"write","sequence":1,"data":"eA==","owner":"x"}`, `{"op":"write","sequence":1,"data":null}`, `{"Op":"write","sequence":1,"data":"eA=="}`, `{"op":"write","sequence":0,"data":"eA=="}`, `{"op":"resize","control":1,"columns":0,"rows":24}`, `{"op":"exec","data":"eA=="}`} {
		if _, err := decodeProcessCommand([]byte(raw)); err == nil {
			t.Fatal("accepted command", raw)
		}
	}
	for _, raw := range []string{`{"op":"output","data":"eA=="}`, `{"op":"resized","control":1}`, `{"op":"ready","state":{"written":0,"exited":false,"failed":false,"exitCode":0}}`} {
		if _, err := decodeProcessEvent([]byte(raw)); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{`{"op":"output","data":"eA==\n"}`, `{"op":"state","state":{"written":1}}`, `{"op":"state","state":{"written":0,"exited":null,"failed":false,"exitCode":0}}`, `{"op":"resized","control":0}`} {
		if _, err := decodeProcessEvent([]byte(raw)); err == nil {
			t.Fatal("accepted event", raw)
		}
	}
}

func TestProcessChannelWritesResizeAndEOFJoin(t *testing.T) {
	worker, client := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer client.Close()
	p := &channelProcess{done: make(chan struct{})}
	finished := make(chan error, 1)
	go func() {
		finished <- ServeProcess(ctx, worker, worker, "bash", 80, 24, func(shell string, c, r int, out func([]byte)) (Process, error) { p.output = out; return p, nil })
	}()
	reader := bufio.NewReader(client)
	read := func() processEvent {
		t.Helper()
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		raw, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		event, err := decodeProcessEvent(raw)
		if err != nil {
			t.Fatal(err)
		}
		return event
	}
	if read().Op != "ready" {
		t.Fatal("missing ready")
	}
	data := []byte("synthetic-中文\r")
	if writeProcessFrame(client, processCommand{Op: "paste", Sequence: 1, Data: base64.StdEncoding.EncodeToString(data)}, RequestLimit) != nil {
		t.Fatal("write")
	}
	event := read()
	if event.Op != "state" || event.State.Written != 1 {
		t.Fatal(event)
	}
	if writeProcessFrame(client, processCommand{Op: "resize", Control: 1, Columns: 120, Rows: 40}, RequestLimit) != nil {
		t.Fatal("resize")
	}
	if read().Op != "resized" {
		t.Fatal("resize ACK missing")
	}
	p.output([]byte(`{"op":"state","state":{"written":99}}`))
	event = read()
	if event.Op != "output" {
		t.Fatal("PTY output interpreted as control", event)
	}
	_ = client.Close()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("EOF did not join")
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("shell retained")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.writes) != 1 || string(p.writes[0]) != string(data) || p.size != [2]int{120, 40} {
		t.Fatal("wrong native operations")
	}
}

func TestProcessChannelNaturalExitDrainsOutputBeforeFinalState(t *testing.T) {
	worker, client := net.Pipe()
	defer client.Close()
	p := &channelProcess{done: make(chan struct{})}
	finished := make(chan error, 1)
	go func() {
		finished <- ServeProcess(context.Background(), worker, worker, "bash", 80, 24, func(_ string, _, _ int, out func([]byte)) (Process, error) { p.output = out; return p, nil })
	}()
	reader := bufio.NewReader(client)
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	p.output([]byte("final output"))
	p.mu.Lock()
	p.state.ExitCode = 7
	p.mu.Unlock()
	p.Close()
	var received []processEvent
	for {
		raw, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var event processEvent
		if json.Unmarshal(raw, &event) != nil {
			t.Fatal("bad frame")
		}
		received = append(received, event)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("natural exit did not join")
	}
	if len(received) != 2 || received[0].Op != "output" || received[1].Op != "state" || !received[1].State.Exited || received[1].State.ExitCode != 7 {
		t.Fatal(received)
	}
}

func TestProcessChannelStalledReaderCancelsInsteadOfDroppingOutput(t *testing.T) {
	worker, client := net.Pipe()
	defer client.Close()
	p := &channelProcess{done: make(chan struct{})}
	finished := make(chan error, 1)
	created := make(chan struct{})
	go func() {
		finished <- ServeProcess(context.Background(), worker, worker, "bash", 80, 24, func(_ string, _, _ int, out func([]byte)) (Process, error) {
			p.output = out
			close(created)
			return p, nil
		})
	}()
	<-created
	for i := 0; i < 16; i++ {
		p.output([]byte("backpressure"))
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("overflow was silently accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked output retained process")
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("native process not joined")
	}
}
