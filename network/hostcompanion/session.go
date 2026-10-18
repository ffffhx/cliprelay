// Package hostcompanion owns one local application's host control service.
// Credentials arrive only over an inherited channel admitted by the executable.
package hostcompanion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"cliprelay/network/inputfocus"
)

const initializationLimit = 96 * 1024

type initialization struct {
	Protocol    int    `json:"protocol"`
	Password    string `json:"password"`
	Certificate []byte `json:"certificate"`
}

type Serve func(context.Context, string, string, inputfocus.EngineAccess, func() error) error

func initializationAccess(raw []byte) (*inputfocus.MemoryEngineAccess, error) {
	// Check key identity and duplication before decoding typed values. A child
	// accepts one fixed credential frame, never a generic RPC or arbitrary path.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errors.New("HOST_INIT_INVALID")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] || (key != "protocol" && key != "password" && key != "certificate") {
			return nil, errors.New("HOST_INIT_INVALID")
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, errors.New("HOST_INIT_INVALID")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(seen) != 3 || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("HOST_INIT_INVALID")
	}
	var init initialization
	if json.Unmarshal(raw, &init) != nil || init.Protocol != 1 {
		return nil, errors.New("HOST_INIT_INVALID")
	}
	access, err := inputfocus.NewMemoryEngineAccess(init.Password, init.Certificate)
	init.Password = ""
	clear(init.Certificate)
	if err != nil {
		return nil, errors.New("HOST_INIT_INVALID")
	}
	return access, nil
}

// writeMessage cannot hold process shutdown if the owning application stops
// reading. Closing the inherited writer releases an in-flight pipe write.
func writeMessage(ctx context.Context, output io.WriteCloser, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return errors.New("HOST_CHANNEL_UNAVAILABLE")
	}
	done := make(chan error, 1)
	go func() {
		n, err := output.Write(append(encoded, '\n'))
		if err == nil && n != len(encoded)+1 {
			err = io.ErrShortWrite
		}
		done <- err
	}()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case err := <-done:
		if err == nil {
			return nil
		}
	case <-ctx.Done():
		_ = output.Close()
		<-done
	case <-timer.C:
		_ = output.Close()
		<-done
	}
	return errors.New("HOST_CHANNEL_UNAVAILABLE")
}

// Run owns input/output until return. Parent checks the executable's actual
// close event for shutdown completion; the only success frame reports bound
// service listeners and explicitly does not claim native auxiliary features.
// Serve must observe cancellation and join its resources before returning.
func Run(parent context.Context, input io.ReadCloser, output io.WriteCloser, stateDir string, ownerPID int, serve Serve) (result error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer output.Close()
	reader := bufio.NewReaderSize(input, initializationLimit+1)
	type firstFrame struct {
		raw []byte
		err error
	}
	first := make(chan firstFrame)
	inputDone := make(chan struct{})
	protocolFailure := make(chan struct{}, 1)
	go func() {
		defer close(inputDone)
		frame, err := reader.ReadSlice('\n')
		copy := append([]byte(nil), frame...)
		clear(frame)
		select {
		case first <- firstFrame{copy, err}:
		case <-ctx.Done():
			clear(copy)
			return
		}
		if err != nil {
			return
		}
		// After initialization, EOF stops the session. Any extra byte is a
		// protocol violation and also stops it, even without another newline.
		if _, err := reader.ReadByte(); err != io.EOF {
			if ctx.Err() == nil {
				protocolFailure <- struct{}{}
			}
		}
		cancel()
	}()
	closeInputDone := make(chan struct{})
	go func() { defer close(closeInputDone); <-ctx.Done(); _ = input.Close() }()
	defer func() {
		cancel()
		<-closeInputDone
		<-inputDone
		if result == nil {
			select {
			case <-protocolFailure:
				result = errors.New("HOST_PROTOCOL_INVALID")
			default:
			}
		}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var access *inputfocus.MemoryEngineAccess
	select {
	case frame := <-first:
		if ctx.Err() != nil && frame.err != nil {
			clear(frame.raw)
			return nil
		}
		if frame.err != nil || len(frame.raw) > initializationLimit {
			clear(frame.raw)
			return errors.New("HOST_INIT_INVALID")
		}
		var err error
		access, err = initializationAccess(frame.raw)
		clear(frame.raw)
		if err != nil {
			return err
		}
	case <-timer.C:
		return errors.New("HOST_INIT_TIMEOUT")
	case <-ctx.Done():
		return nil
	}
	defer access.Close()
	if ctx.Err() != nil {
		return nil
	}
	if err := validateState(stateDir); err != nil {
		return err
	}
	runtime, err := newRuntime()
	if err != nil {
		return err
	}
	defer func() {
		if err := runtime.close(); err != nil {
			result = err
		}
	}()
	if ctx.Err() != nil {
		return nil
	}
	if serve == nil {
		return errors.New("HOST_SERVICE_UNAVAILABLE")
	}
	err = serve(ctx, stateDir, runtime.path, access.Read, func() error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return writeMessage(ctx, output, struct {
			Type          string `json:"type"`
			Protocol      int    `json:"protocol"`
			PID           int    `json:"pid"`
			OwnerPID      int    `json:"ownerPid"`
			IPC           string `json:"ipc"`
			NativeWorkers bool   `json:"nativeWorkers"`
		}{"listening", 1, os.Getpid(), ownerPID, filepath.Join(runtime.path, "clipboard-relay.sock"), false})
	})
	select {
	case <-protocolFailure:
		return errors.New("HOST_PROTOCOL_INVALID")
	default:
	}
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		return errors.New("HOST_SERVICE_UNAVAILABLE")
	}
	return errors.New("HOST_SERVICE_STOPPED")
}
