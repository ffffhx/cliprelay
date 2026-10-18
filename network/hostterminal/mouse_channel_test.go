package hostterminal

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

type mouseChannelProcess struct {
	*channelProcess
	q *InputQueue
}

func (p *mouseChannelProcess) Mouse(c MouseCommand) error { return p.q.Mouse(c) }
func (p *mouseChannelProcess) MouseState() MouseState     { return p.q.State() }
func (p *mouseChannelProcess) Resize(c, r int) error {
	p.q.Resize(c, r)
	return p.channelProcess.Resize(c, r)
}
func (p *mouseChannelProcess) Close() { p.q.Stop(); p.channelProcess.Close() }

func TestMouseOwnedFramesRejectAmbiguity(t *testing.T) {
	c := MouseCommand{Action: "press", Sequence: 1, Epoch: 3, Gesture: 1, Column: 5, Row: 7}
	raw, _ := json.Marshal(c)
	if _, err := decodeMouseCommand(raw); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{strings.Replace(string(raw), `"button":0`, `"button":0,"button":1`, 1), strings.Replace(string(raw), `"epoch":3`, `"Epoch":3`, 1), strings.Replace(string(raw), `"button":0`, `"button":null`, 1), strings.Replace(string(raw), `"gesture":1`, `"gesture":9007199254740992`, 1)} {
		if _, err := decodeMouseCommand([]byte(text)); err == nil {
			t.Fatal("ambiguous command accepted", text)
		}
	}
	s := initialMouseState()
	raw, _ = json.Marshal(s)
	if _, err := decodeMouseState(raw); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{strings.Replace(string(raw), `"epoch":1`, `"epoch":1,"epoch":2`, 1), strings.Replace(string(raw), `"epoch":1`, `"Epoch":1`, 1), strings.Replace(string(raw), `"remainingMs":0`, `"remainingMs":null`, 1), strings.Replace(string(raw), `"writtenSequence":0`, `"writtenSequence":1`, 1)} {
		if _, err := decodeMouseState([]byte(text)); err == nil {
			t.Fatal("ambiguous state accepted", text)
		}
	}
	owner, id := strings.Repeat("a", 64), strings.Repeat("b", 32)
	frame := `{"op":"mouse","owner":"` + owner + `","instance":"` + id + `","id":"` + id + `","sequence":1,"action":"move","epoch":1,"gesture":0,"column":5,"row":7,"button":3}`
	if _, err := Decode([]byte(frame)); err != nil {
		t.Fatal("HTTP omitted zero modifiers rejected", err)
	}
	for _, text := range []string{strings.Replace(frame, `"gesture":0,`, "", 1), strings.Replace(frame, `"column":5`, `"column":null`, 1), strings.Replace(frame, `"epoch":1`, `"epoch":1,"epoch":2`, 1)} {
		if _, err := Decode([]byte(text)); err == nil {
			t.Fatal("invalid owned request accepted", text)
		}
	}
}

func TestGuardianMouseRejectsFutureOffsetsAndUnconfirmedAcceptances(t *testing.T) {
	newGuardian := func() *guardedProcess {
		p := &guardedProcess{ready: make(chan struct{})}
		if !p.accept(processEvent{Op: "ready", State: &ProcessState{}, MouseProtocol: 1}) {
			t.Fatal("ready")
		}
		return p
	}
	for _, bad := range []string{"offset", "accepted", "written", "epoch"} {
		t.Run(bad, func(t *testing.T) {
			p := newGuardian()
			m := initialMouseState()
			switch bad {
			case "offset":
				m.Offset = 1
			case "accepted":
				m.AcceptedSequence = 1
			case "written":
				m.WrittenSequence = 1
			case "epoch":
				m.Epoch = 0
			}
			if p.accept(processEvent{Op: "state", State: &ProcessState{}, Mouse: &m}) {
				t.Fatal("invalid state accepted", m)
			}
		})
	}
	p := newGuardian()
	p.outputEnd = 15
	c := MouseCommand{Action: "press", Sequence: 1, Epoch: 3, Gesture: 1, Column: 5, Row: 7}
	p.controlCommand = processCommand{Op: "mouse", Control: 1, Mouse: &c}
	p.controlReply = make(chan error, 1)
	m := MouseState{Mode: 1002, Format: 1006, Epoch: 3, Offset: 15, Gesture: 1, NextGesture: 2, AcceptedSequence: 1, Phase: "pending", Outcome: "queued", RemainingMs: 1500}
	if !p.accept(processEvent{Op: "mouse", Control: 1, Mouse: &m}) {
		t.Fatal("native receipt rejected")
	}
	m.AcceptedSequence = 2
	if p.accept(processEvent{Op: "state", State: &ProcessState{}, Mouse: &m}) {
		t.Fatal("periodic state invented acceptance")
	}
	m.AcceptedSequence = 1
	m.WrittenSequence = 1
	m.Buttons = 1
	m.Phase = "held"
	m.Outcome = "written"
	if !p.accept(processEvent{Op: "state", State: &ProcessState{}, Mouse: &m}) {
		t.Fatal("native write receipt rejected")
	}
	p.mouseAt = time.Now().Add(-time.Second)
	if p.MouseState().RemainingMs > 500 {
		t.Fatal("stale snapshot extended lease")
	}
}

func TestProcessChannelMouseReceiptsAndOutputOrdering(t *testing.T) {
	worker, client := net.Pipe()
	defer client.Close()
	start := time.Now()
	q := NewInputQueue(func() int64 { return time.Since(start).Milliseconds() }, 80, 24)
	p := &mouseChannelProcess{channelProcess: &channelProcess{done: make(chan struct{})}, q: q}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- ServeProcess(ctx, worker, worker, "bash", 80, 24, func(_ string, _, _ int, out func([]byte)) (Process, error) {
			p.output = out
			q.Observe([]byte("\x1b[?1002;1006h"), out)
			return p, nil
		})
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
			t.Fatal(string(raw), err)
		}
		return event
	}
	ready := read()
	if ready.Op != "ready" || ready.MouseProtocol != 1 || ready.Mouse != nil {
		t.Fatal("mode exposed before initial output", ready)
	}
	if read().Op != "output" {
		t.Fatal("initial output not retained")
	}
	await := func(op string) processEvent {
		t.Helper()
		for i := 0; i < 50; i++ {
			event := read()
			if event.Op == op {
				return event
			}
		}
		t.Fatal("receipt missing", op)
		return processEvent{}
	}
	c := MouseCommand{Action: "press", Sequence: 1, Epoch: q.State().Epoch, Gesture: 1, Column: 5, Row: 7}
	send := func(control int64, c MouseCommand) processEvent {
		t.Helper()
		if writeProcessFrame(client, processCommand{Op: "mouse", Control: control, Mouse: &c}, RequestLimit) != nil {
			t.Fatal("write")
		}
		return await("mouse")
	}
	ack := send(1, c)
	if ack.Code != "" || ack.Mouse.AcceptedSequence != 1 || ack.Mouse.WrittenSequence != 0 || ack.Mouse.Offset > int64(len("\x1b[?1002;1006h")) {
		t.Fatal(ack)
	}
	ack = send(2, c)
	if ack.Code != "" || ack.Mouse.AcceptedSequence != 1 {
		t.Fatal("lost reply retry", ack)
	}
	bad := c
	bad.Sequence = 3
	ack = send(3, bad)
	if ack.Code != "TERMINAL_MOUSE_SEQUENCE" || ack.Mouse.AcceptedSequence != 1 {
		t.Fatal("error advanced native receipt", ack)
	}
	if writeProcessFrame(client, processCommand{Op: "resize", Control: 4, Columns: 100, Rows: 30}, RequestLimit) != nil {
		t.Fatal("resize")
	}
	resized := await("resized")
	if resized.Mouse.Epoch <= c.Epoch || resized.Mouse.AcceptedSequence != 1 {
		t.Fatal("resize acknowledged without mode invalidation", resized)
	}
	_ = client.Close()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("mouse worker did not join")
	}
}
