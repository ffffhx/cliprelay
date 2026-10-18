//go:build darwin || linux

package hostfiles

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
	"unicode/utf8"
)

// Serve owns its channels and store through shutdown. The application-owned
// supervisor also bounds worker exit and can kill a stalled filesystem call.
// There is no listener, shell execution, command expansion or path in errors.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, options Options) error {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	defer func() { cancel(); <-closed }()
	store, err := Open(ctx, options)
	if err != nil {
		return errors.New(errorCode(err))
	}
	defer store.Close()
	reader := bufio.NewReaderSize(input, MessageLimit+1)
	for {
		line, err := reader.ReadSlice('\n')
		if err == io.EOF && len(line) == 0 {
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		if err != nil || len(line) > MessageLimit || !utf8.Valid(line) || !bytes.HasPrefix(line, []byte("files:")) {
			return errors.New("FILES_PROTOCOL_INVALID")
		}
		var request Request
		decoder := json.NewDecoder(bytes.NewReader(line[6:]))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
			return errors.New("FILES_PROTOCOL_INVALID")
		}
		value := store.Handle(request)
		raw, err := json.Marshal(value)
		if err != nil || len(raw)+1 > MessageLimit {
			return errors.New("FILES_PROTOCOL_INVALID")
		}
		if deadline, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if deadline.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
				return errors.New("FILES_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		n, err := output.Write(raw)
		if err != nil || n != len(raw) {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("FILES_CHANNEL_UNAVAILABLE")
		}
	}
}

func ServeDefault(ctx context.Context, input io.ReadCloser, output io.WriteCloser, stateDirectory string) error {
	options, err := DefaultOptions(stateDirectory)
	if err != nil {
		_ = input.Close()
		_ = output.Close()
		return errors.New(errorCode(err))
	}
	return Serve(ctx, input, output, options)
}
