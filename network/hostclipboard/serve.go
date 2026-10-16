package hostclipboard

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Serve owns both channels. The supervising process separately bounds a native
// clipboard call that stalls inside the OS, and never replays an uncertain write.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, access Access) error {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	defer func() { cancel(); <-closed }()
	exchange := New(access)
	reader := bufio.NewReaderSize(input, MessageLimit+1)
	for {
		line, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || (err == io.EOF && len(line) == 0) {
			return nil
		}
		if err != nil || len(line) > MessageLimit {
			return errors.New("CLIPBOARD_PROTOCOL_INVALID")
		}
		request, err := decode(line)
		if err != nil {
			return err
		}
		value := exchange.Handle(ctx, request)
		if ctx.Err() != nil {
			return nil
		}
		raw, err := json.Marshal(value)
		if err != nil || len(raw)+1 > MessageLimit {
			return errors.New("CLIPBOARD_PROTOCOL_INVALID")
		}
		if deadline, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if deadline.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
				return errors.New("CLIPBOARD_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		if n, err := output.Write(raw); err != nil || n != len(raw) {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("CLIPBOARD_CHANNEL_UNAVAILABLE")
		}
	}
}
