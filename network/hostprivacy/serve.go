package hostprivacy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Serve owns its private pipes. A native runner must also enforce Deadline
// and parent/context death outside this loop, including during a stuck UI call.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, controller *Controller) (result error) {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	defer func() {
		controller.Withdraw()
		cancel()
		<-closed
		if err := controller.Close(); err != nil {
			result = err
		}
	}()
	reader := bufio.NewReaderSize(input, 1024)
	for {
		line, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || (err == io.EOF && len(line) == 0) {
			return nil
		}
		if err != nil || len(line) > 512 {
			return errors.New("PRIVACY_PROTOCOL_INVALID")
		}
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		var request Request
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			return errors.New("PRIVACY_PROTOCOL_INVALID")
		}
		value, err := controller.Handle(request)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		raw, err := json.Marshal(value)
		if err != nil || len(raw)+1 > 8192 {
			return errors.New("PRIVACY_PROTOCOL_INVALID")
		}
		if channel, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if channel.SetWriteDeadline(time.Now().Add(time.Second)) != nil {
				return errors.New("PRIVACY_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		if n, err := output.Write(raw); err != nil || n != len(raw) {
			return errors.New("PRIVACY_CHANNEL_UNAVAILABLE")
		}
	}
}
