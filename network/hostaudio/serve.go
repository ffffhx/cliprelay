package hostaudio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Serve accepts only the existing private audio-mute worker line protocol.
// A native runner additionally watches the lease during blocked native calls.
func Serve(parent context.Context, input io.ReadCloser, output io.WriteCloser, c *Controller) (result error) {
	ctx, cancel := context.WithCancel(parent)
	closed := make(chan struct{})
	go func() { defer close(closed); <-ctx.Done(); _ = input.Close(); _ = output.Close() }()
	defer func() {
		c.Withdraw()
		cancel()
		<-closed
		if err := c.Close(); err != nil {
			result = err
		}
	}()
	reader := bufio.NewReaderSize(input, 1024)
	for {
		line, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || (err == io.EOF && len(line) == 0) {
			return nil
		}
		prefix := []byte("audio-mute:")
		if err != nil || len(line) > 512 || !bytes.HasPrefix(line, prefix) {
			return errors.New("AUDIO_PROTOCOL_INVALID")
		}
		raw := line[len(prefix):]
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var q Request
		if decoder.Decode(&q) != nil || decoder.Decode(new(any)) != io.EOF {
			return errors.New("AUDIO_PROTOCOL_INVALID")
		}
		// A canonical-key object prevents duplicate and case-alias commands.
		keys := json.NewDecoder(bytes.NewReader(raw))
		first, _ := keys.Token()
		if first != json.Delim('{') {
			return errors.New("AUDIO_PROTOCOL_INVALID")
		}
		seen := map[string]bool{}
		for keys.More() {
			token, e := keys.Token()
			name, ok := token.(string)
			if e != nil || !ok || (name != "op" && name != "lease") || seen[name] {
				return errors.New("AUDIO_PROTOCOL_INVALID")
			}
			seen[name] = true
			var value string
			if keys.Decode(&value) != nil {
				return errors.New("AUDIO_PROTOCOL_INVALID")
			}
		}
		value, err := c.Handle(q)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		raw, err = json.Marshal(value)
		if err != nil || len(raw) > 4095 {
			return errors.New("AUDIO_PROTOCOL_INVALID")
		}
		if channel, ok := output.(interface{ SetWriteDeadline(time.Time) error }); ok {
			if channel.SetWriteDeadline(time.Now().Add(time.Second)) != nil {
				return errors.New("AUDIO_CHANNEL_UNAVAILABLE")
			}
		}
		raw = append(raw, '\n')
		if n, err := output.Write(raw); err != nil || n != len(raw) {
			return errors.New("AUDIO_CHANNEL_UNAVAILABLE")
		}
	}
}
