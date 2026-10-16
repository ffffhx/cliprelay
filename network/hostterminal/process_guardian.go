package hostterminal

import (
	"bufio"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

type pendingProcessInput struct {
	sequence int64
	size     int
}
type guardedProcess struct {
	mu                                     sync.Mutex
	state                                  ProcessState
	command                                *exec.Cmd
	input, output                          *os.File
	queue                                  chan processCommand
	pending                                []pendingProcessInput
	queued                                 int
	sequence, control, outputEnd           int64
	controlCommand                         processCommand
	controlReply                           chan error
	controlEpoch                           int64
	mouse                                  MouseState
	mouseAt                                time.Time
	closing, readySeen                     bool
	ready, stop, done, readDone, writeDone chan struct{}
}

// StartGuarded only accepts an application-built command, never a client path
// or arbitrary arguments. The helper must run ServeProcess and independently
// watch its direct parent. Manager acceptance belongs to this proxy; Written
// advances solely when the native helper confirms an entire frame reached PTY.
func StartGuarded(command *exec.Cmd, output func([]byte)) (Process, error) {
	if command == nil || command.Stdin != nil || command.Stdout != nil || command.Stderr != nil {
		return nil, errProcessChannel
	}
	childInput, input, err := os.Pipe()
	if err != nil {
		return nil, errProcessChannel
	}
	readOutput, childOutput, err := os.Pipe()
	if err != nil {
		_ = childInput.Close()
		_ = input.Close()
		return nil, errProcessChannel
	}
	command.Stdin = childInput
	command.Stdout = childOutput
	command.Stderr = io.Discard
	err = command.Start()
	_ = childInput.Close()
	_ = childOutput.Close()
	if err != nil {
		_ = input.Close()
		_ = readOutput.Close()
		return nil, errProcessChannel
	}
	p := &guardedProcess{command: command, input: input, output: readOutput, queue: make(chan processCommand, 8), ready: make(chan struct{}), stop: make(chan struct{}), done: make(chan struct{}), readDone: make(chan struct{}), writeDone: make(chan struct{})}
	go p.read(output)
	go p.write()
	go p.monitor()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-p.ready:
		p.mu.Lock()
		valid := !p.closing && !p.state.Exited && !p.state.Failed
		p.mu.Unlock()
		if valid {
			return p, nil
		}
	case <-p.done:
	case <-timer.C:
	}
	p.fail()
	return p, errProcessChannel
}
func (p *guardedProcess) fail() { p.mu.Lock(); p.state.Failed = true; p.mu.Unlock(); p.Close() }
func (p *guardedProcess) Queue(data []byte, sequence int64, paste bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	limit := 4096
	op := "write"
	if paste {
		limit = PasteLimit
		op = "paste"
	}
	if p.closing || !p.readySeen || p.state.Exited || p.state.Failed || len(data) < 1 || len(data) > limit || p.queued+len(data) > 32768 || len(p.pending) >= 8 || sequence != p.sequence+1 || sequence > MaxSequence {
		return false
	}
	command := processCommand{Op: op, Sequence: sequence, Data: base64.StdEncoding.EncodeToString(data)}
	select {
	case p.queue <- command:
		p.sequence = sequence
		p.queued += len(data)
		p.pending = append(p.pending, pendingProcessInput{sequence, len(data)})
		return true
	default:
		return false
	}
}
func (p *guardedProcess) Resize(columns, rows int) error {
	if !dimensions(columns, rows) {
		return errors.New("TERMINAL_BAD_REQUEST")
	}
	return p.sendControl(processCommand{Op: "resize", Columns: columns, Rows: rows})
}
func (p *guardedProcess) Mouse(command MouseCommand) error {
	if !validMouseCommand(command) {
		return errors.New("TERMINAL_BAD_REQUEST")
	}
	return p.sendControl(processCommand{Op: "mouse", Mouse: &command})
}
func (p *guardedProcess) MouseState() MouseState {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.mouse
	state.RemainingMs = max(0, state.RemainingMs-time.Since(p.mouseAt).Milliseconds())
	if p.state.Exited {
		state.Phase, state.Buttons, state.RemainingMs = "closed", 0, 0
	}
	return state
}
func (p *guardedProcess) sendControl(command processCommand) error {
	p.mu.Lock()
	if p.closing || !p.readySeen || p.state.Exited || p.state.Failed || p.control >= MaxSequence {
		p.mu.Unlock()
		return errors.New("TERMINAL_CLOSED")
	}
	if p.controlReply != nil {
		p.mu.Unlock()
		return errors.New("TERMINAL_BUSY")
	}
	reply := make(chan error, 1)
	command.Control = p.control + 1
	select {
	case p.queue <- command:
		p.control = command.Control
		p.controlCommand = command
		p.controlReply = reply
		p.controlEpoch = p.mouse.Epoch
	default:
		p.mu.Unlock()
		return errors.New("TERMINAL_BUSY")
	}
	p.mu.Unlock()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case err := <-reply:
		return err
	case <-p.stop:
		return errProcessChannel
	case <-timer.C:
		p.fail()
		return errProcessChannel
	}
}
func (p *guardedProcess) Status() ProcessState { p.mu.Lock(); defer p.mu.Unlock(); return p.state }
func (p *guardedProcess) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closing {
		p.closing = true
		close(p.stop)
	}
}
func (p *guardedProcess) Done() <-chan struct{} { return p.done }
func (p *guardedProcess) write() {
	defer close(p.writeDone)
	for {
		select {
		case <-p.stop:
			return
		case command := <-p.queue:
			p.mu.Lock()
			closing := p.closing
			p.mu.Unlock()
			if closing {
				return
			}
			if writeProcessFrame(p.input, command, RequestLimit) != nil {
				p.fail()
				return
			}
		}
	}
}
func (p *guardedProcess) accept(event processEvent) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if event.Op == "ready" {
		if p.readySeen || *event.State != (ProcessState{}) || event.MouseProtocol != 1 {
			return false
		}
		p.readySeen = true
		p.mouse, p.mouseAt = initialMouseState(), time.Now()
		close(p.ready)
		return true
	}
	if !p.readySeen || p.state.Exited {
		return false
	}
	switch event.Op {
	case "output":
		return true
	case "resized", "mouse":
		expectedOp := "resize"
		if event.Op == "mouse" {
			expectedOp = "mouse"
		}
		if p.controlReply == nil || event.Control != p.controlCommand.Control || p.controlCommand.Op != expectedOp || event.Mouse == nil {
			return false
		}
		accepted := p.mouse.AcceptedSequence
		if event.Op == "mouse" && event.Code == "" {
			accepted = p.controlCommand.Mouse.Sequence
		}
		if event.Mouse.AcceptedSequence != accepted || !p.acceptMouse(*event.Mouse, accepted) || event.Op == "resized" && event.Mouse.Epoch <= p.controlEpoch {
			return false
		}
		p.mouse, p.mouseAt = *event.Mouse, time.Now()
		var err error
		if event.Code != "" {
			err = errors.New(event.Code)
		}
		p.controlReply <- err
		p.controlReply = nil
		return true
	case "state":
		state := *event.State
		if state.Written < p.state.Written || state.Written > p.sequence || p.state.Failed && !state.Failed || event.Mouse == nil || !p.acceptMouse(*event.Mouse, p.mouse.AcceptedSequence) {
			return false
		}
		for len(p.pending) > 0 && p.pending[0].sequence <= state.Written {
			p.queued -= p.pending[0].size
			p.pending = p.pending[1:]
		}
		p.state = state
		p.mouse, p.mouseAt = *event.Mouse, time.Now()
		return true
	}
	return false
}

// Called under mu. A periodic snapshot cannot invent an acceptance: only the
// matching synchronous native mouse receipt may advance AcceptedSequence.
func (p *guardedProcess) acceptMouse(state MouseState, accepted int64) bool {
	return validMouseState(state, p.outputEnd) && state.Epoch >= p.mouse.Epoch && state.Offset >= p.mouse.Offset && state.Gesture >= p.mouse.Gesture && state.NextGesture >= p.mouse.NextGesture && state.AcceptedSequence >= p.mouse.AcceptedSequence && state.AcceptedSequence <= accepted && state.WrittenSequence >= p.mouse.WrittenSequence
}
func (p *guardedProcess) read(output func([]byte)) {
	defer close(p.readDone)
	reader := bufio.NewReaderSize(p.output, ReplyLimit+1)
	for {
		raw, err := reader.ReadSlice('\n')
		if err != nil {
			p.mu.Lock()
			expected := p.closing || err == io.EOF && len(raw) == 0 && p.state.Exited
			p.mu.Unlock()
			if !expected {
				p.fail()
			}
			return
		}
		event, err := decodeProcessEvent(raw)
		if err != nil || !p.accept(event) {
			p.fail()
			return
		}
		if event.Op == "output" {
			data, _ := processBytes(event.Data, ReadLimit)
			output(data)
			p.mu.Lock()
			p.outputEnd += int64(len(data))
			p.mu.Unlock()
		}
	}
}
func (p *guardedProcess) monitor() {
	defer close(p.done)
	waited := make(chan error, 1)
	go func() { waited <- p.command.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waited:
		// A final state can be buffered after the process exits. Join the reader
		// before judging that receipt, with a bound for a broken output consumer.
		select {
		case <-p.readDone:
		case <-time.After(3 * time.Second):
			p.fail()
		}
		p.Close()
	case <-p.stop:
		// EOF reaches the independent helper and starts native shell teardown.
		_ = p.input.Close()
		timer := time.NewTimer(5 * time.Second)
		select {
		case waitErr = <-waited:
		case <-timer.C:
			_ = p.command.Process.Kill()
			waitErr = <-waited
		}
		timer.Stop()
	}
	_ = p.input.Close()
	_ = p.output.Close()
	<-p.readDone
	<-p.writeDone
	p.mu.Lock()
	if waitErr != nil || !p.state.Exited {
		p.state.Failed = true
	}
	p.state.Exited = true
	p.mu.Unlock()
}
