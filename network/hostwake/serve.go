package hostwake

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Serve owns the pipe endpoints; EOF/cancellation withdraws the owner. The
// companion's existing guardian also bounds a native OS call that stalls.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, read func() (Inventory, error)) error {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	defer func() { cancel(); <-closed }()
	reader := bufio.NewReaderSize(input, 128)
	for {
		line, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || (err == io.EOF && len(line) == 0) {
			return nil
		}
		if err != nil || string(line) != "wake-status\n" {
			return errors.New("WAKE_PROTOCOL_INVALID")
		}
		value, readErr := read()
		if ctx.Err() != nil {
			return nil
		}
		var reply any = value
		if readErr != nil {
			reply = map[string]any{"ok": false, "supported": false, "code": "WAKE_UNAVAILABLE", "platform": "macos", "wakeVerified": false}
		}
		raw, err := json.Marshal(reply)
		if err != nil || len(raw)+1 > 65536 {
			return errors.New("WAKE_PROTOCOL_INVALID")
		}
		if channel, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if channel.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
				return errors.New("WAKE_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		if n, err := output.Write(raw); err != nil || n != len(raw) {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("WAKE_CHANNEL_UNAVAILABLE")
		}
	}
}
