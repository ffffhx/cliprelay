package hostterminal

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// The session guardian's private channel is separate from the PTY. Shell output
// can never be interpreted as a worker reply, and output is never persisted.
type processCommand struct {
	Op       string `json:"op"`
	Sequence int64  `json:"sequence,omitempty"`
	Data     string `json:"data,omitempty"`
	Control  int64  `json:"control,omitempty"`
	Columns  int    `json:"columns,omitempty"`
	Rows     int    `json:"rows,omitempty"`
}
type processEvent struct {
	Op      string        `json:"op"`
	State   *ProcessState `json:"state,omitempty"`
	Data    string        `json:"data,omitempty"`
	Control int64         `json:"control,omitempty"`
}

var errProcessChannel = errors.New("TERMINAL_CHANNEL_UNAVAILABLE")

func processBytes(value string, limit int) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) == 0 || len(data) > limit || base64.StdEncoding.EncodeToString(data) != value {
		return nil, errProcessChannel
	}
	return data, nil
}
func decodeProcessCommand(raw []byte) (processCommand, error) {
	var command processCommand
	fields, err := objectFields(raw, RequestLimit)
	if err != nil || json.Unmarshal(raw, &command) != nil {
		return command, errProcessChannel
	}
	switch command.Op {
	case "write", "paste":
		limit := 4096
		if command.Op == "paste" {
			limit = PasteLimit
		}
		_, err = processBytes(command.Data, limit)
		if !exactFields(fields, "op,sequence,data") || command.Sequence < 1 || command.Sequence > MaxSequence || err != nil {
			return command, errProcessChannel
		}
	case "resize":
		if !exactFields(fields, "op,control,columns,rows") || command.Control < 1 || command.Control > MaxSequence || !dimensions(command.Columns, command.Rows) {
			return command, errProcessChannel
		}
	default:
		return command, errProcessChannel
	}
	return command, nil
}
func decodeProcessEvent(raw []byte) (processEvent, error) {
	var event processEvent
	fields, err := objectFields(raw, ReplyLimit)
	if err != nil || json.Unmarshal(raw, &event) != nil {
		return event, errProcessChannel
	}
	switch event.Op {
	case "ready", "state":
		if !exactFields(fields, "op,state") || event.State == nil {
			return event, errProcessChannel
		}
		state, err := objectFields(fields["state"], 256)
		if err != nil || !exactFields(state, "written,exited,failed,exitCode") || event.State.Written < 0 || event.State.Written > MaxSequence || event.State.ExitCode < -2147483648 || event.State.ExitCode > 2147483647 {
			return event, errProcessChannel
		}
	case "output":
		if !exactFields(fields, "op,data") {
			return event, errProcessChannel
		}
		if _, err = processBytes(event.Data, ReadLimit); err != nil {
			return event, err
		}
	case "resized":
		if !exactFields(fields, "op,control") || event.Control < 1 || event.Control > MaxSequence {
			return event, errProcessChannel
		}
	default:
		return event, errProcessChannel
	}
	return event, nil
}
func writeProcessFrame(output io.Writer, value any, limit int) error {
	raw, err := json.Marshal(value)
	if err != nil || len(raw)+1 > limit {
		return errProcessChannel
	}
	if deadline, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
		if deadline.SetWriteDeadline(time.Now().Add(3*time.Second)) != nil {
			return errProcessChannel
		}
	}
	raw = append(raw, '\n')
	if n, err := output.Write(raw); err != nil || n != len(raw) {
		return errProcessChannel
	}
	return nil
}

// ServeProcess must run in a dedicated child with an independent parent watcher.
// Its only child is the native shell. EOF, cancellation or malformed IPC closes
// that PTY and joins the shell before returning. The caller bounds process exit.
func ServeProcess(parent context.Context, input io.ReadCloser, output io.WriteCloser, shell string, columns, rows int, create Factory) (result error) {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	events := make(chan processEvent, 8)
	emit := func(event processEvent) bool {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		select {
		case events <- event:
			return true
		default:
		}
		// Temporary backpressure must not discard output or kill a busy shell.
		// A reader that remains blocked is bounded independently of new input.
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		select {
		case events <- event:
			return true
		case <-ctx.Done():
			return false
		case <-timer.C:
			cancel()
			return false
		}
	}
	process, err := create(shell, columns, rows, func(data []byte) {
		for len(data) > 0 {
			size := min(len(data), ReadLimit)
			if !emit(processEvent{Op: "output", Data: base64.StdEncoding.EncodeToString(data[:size])}) {
				return
			}
			data = data[size:]
		}
	})
	if err != nil {
		cancel()
		<-closed
		if process != nil {
			process.Close()
			select {
			case <-process.Done():
			case <-time.After(4 * time.Second):
			}
		}
		return errProcessChannel
	}
	readDone, writeDone := make(chan struct{}), make(chan error, 1)
	commands := make(chan processCommand)
	go func() {
		defer close(readDone)
		reader := bufio.NewReaderSize(input, RequestLimit+1)
		for {
			raw, err := reader.ReadSlice('\n')
			if err != nil {
				cancel()
				return
			}
			command, err := decodeProcessCommand(raw)
			if err != nil {
				cancel()
				return
			}
			select {
			case commands <- command:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		state := process.Status()
		err := writeProcessFrame(output, processEvent{Op: "ready", State: &state}, ReplyLimit)
		if err == nil {
		writeLoop:
			for {
				select {
				case <-ctx.Done():
					err = errProcessChannel
					break writeLoop
				case event, ok := <-events:
					if !ok {
						break writeLoop
					}
					if err = writeProcessFrame(output, event, ReplyLimit); err != nil {
						break writeLoop
					}
				}
			}
		}
		if err != nil {
			cancel()
		}
		writeDone <- err
	}()
	defer func() {
		cancel()
		<-closed
		process.Close()
		select {
		case <-process.Done():
		case <-time.After(4 * time.Second):
			result = errors.New("TERMINAL_SHUTDOWN_TIMEOUT")
		}
		<-readDone
		// Cancellation wakes the writer directly. Do not close a channel that a
		// cancelled output callback could still be leaving during shutdown.
		select {
		case <-writeDone:
		case <-time.After(time.Second):
			result = errors.New("TERMINAL_SHUTDOWN_TIMEOUT")
		}
	}()
	ticker := time.NewTicker(30 * time.Millisecond)
	defer ticker.Stop()
	var sequence, control int64
	last := process.Status()
	for {
		select {
		case <-ctx.Done():
			return errProcessChannel
		case <-process.Done():
			// Drain all output already produced before the final state. The writer
			// owns stdout; the parent sees natural exit only after those frames.
			state := process.Status()
			select {
			case events <- processEvent{Op: "state", State: &state}:
			case <-ctx.Done():
				return errProcessChannel
			}
			close(events)
			writeErr := <-writeDone
			// Preserve the writer's completion for the common join path.
			writeDone <- writeErr
			return writeErr
		case <-ticker.C:
			state := process.Status()
			if !state.Exited && state != last {
				if !emit(processEvent{Op: "state", State: &state}) {
					return errProcessChannel
				}
				last = state
			}
		case command := <-commands:
			if command.Op == "resize" {
				if command.Control != control+1 || process.Resize(command.Columns, command.Rows) != nil {
					return errProcessChannel
				}
				control = command.Control
				if !emit(processEvent{Op: "resized", Control: control}) {
					return errProcessChannel
				}
			} else {
				data, _ := processBytes(command.Data, PasteLimit)
				if command.Sequence != sequence+1 || !process.Queue(data, command.Sequence, command.Op == "paste") {
					return errProcessChannel
				}
				sequence = command.Sequence
			}
		}
	}
}
