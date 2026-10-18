//go:build darwin || linux

package hostfiles

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func TestWorkerFramesAndEOFReleaseStore(t *testing.T) {
	f := newStoreFixture(t)
	f.store.Close()
	input, send := io.Pipe()
	receive, output := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), input, output, f.options) }()
	q := Request{Owner: firstOwner, Op: "roots"}
	raw, _ := json.Marshal(q)
	if _, err := send.Write(append(append([]byte("files:"), raw...), '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(receive).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var reply Response
	if json.Unmarshal(line, &reply) != nil || !reply.OK || reply.ChunkSize != ChunkSize || len(reply.Roots) != 1 {
		t.Fatal("bad worker reply")
	}
	send.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("worker retained EOF owner")
	}
	f.reopen(t)
}

func TestWorkerMalformedFramesAndCancellationCloseChannels(t *testing.T) {
	for _, frame := range []string{"unknown:{}\n", "files:{\"op\":\"roots\",\"extra\":1}\n", "files:{}{}\n", "files:" + strings.Repeat(" ", MessageLimit) + "\n", "files:{\"op\":\"\xff\"}\n"} {
		t.Run(frame[:min(len(frame), 20)], func(t *testing.T) {
			f := newStoreFixture(t)
			f.store.Close()
			input, send := io.Pipe()
			receive, output := io.Pipe()
			done := make(chan error, 1)
			go func() { done <- Serve(context.Background(), input, output, f.options) }()
			_, _ = send.Write([]byte(frame))
			send.Close()
			receive.Close()
			select {
			case err := <-done:
				if err == nil || err.Error() != "FILES_PROTOCOL_INVALID" {
					t.Fatal("malformed frame accepted", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("invalid frame retained worker")
			}
			f.reopen(t)
		})
	}
	f := newStoreFixture(t)
	f.store.Close()
	input, send := io.Pipe()
	receive, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, input, output, f.options) }()
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation retained idle reader")
	}
	send.Close()
	receive.Close()
	f.reopen(t)
}
