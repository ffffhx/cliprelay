package hostterminal

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Serve joins the authorization timer and owned session processes before
// returning. A parent guardian separately bounds shutdown if native I/O stalls.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, create Factory) (result error) {
	ctx, cancel := context.WithCancel(parent)
	start := time.Now()
	manager := New(func() int64 { return time.Since(start).Milliseconds() }, create)
	channelsClosed := make(chan struct{})
	maintained := make(chan struct{})
	go func() { defer close(channelsClosed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	go func() {
		defer close(maintained)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				manager.Maintain()
			}
		}
	}()
	defer func() {
		cancel()
		<-channelsClosed
		<-maintained
		processes := manager.Close()
		timer := time.NewTimer(4 * time.Second)
		defer timer.Stop()
		for _, process := range processes {
			select {
			case <-process.Done():
			case <-timer.C:
				result = errors.New("TERMINAL_SHUTDOWN_TIMEOUT")
				return
			}
		}
	}()
	reader := bufio.NewReaderSize(input, RequestLimit+1)
	for {
		line, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || err == io.EOF && len(line) == 0 {
			return nil
		}
		if err != nil || len(line) > RequestLimit {
			return errors.New("TERMINAL_PROTOCOL_INVALID")
		}
		request, err := Decode(line)
		if err != nil {
			return err
		}
		value := manager.Handle(request)
		if ctx.Err() != nil {
			return nil
		}
		raw, err := json.Marshal(value)
		if err != nil || len(raw)+1 > ReplyLimit {
			return errors.New("TERMINAL_PROTOCOL_INVALID")
		}
		if deadline, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if deadline.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
				return errors.New("TERMINAL_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		if n, err := output.Write(raw); err != nil || n != len(raw) {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("TERMINAL_CHANNEL_UNAVAILABLE")
		}
	}
}
