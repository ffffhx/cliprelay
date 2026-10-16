package hostcompanion

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type bufferOutput struct{ bytes.Buffer }

func (*bufferOutput) Close() error { return nil }

func credentialFixture(t *testing.T) []byte {
	t.Helper()
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	frame, err := json.Marshal(initialization{1, strings.Repeat("private-fixture", 3), server.Certificate().Raw})
	if err != nil {
		t.Fatal(err)
	}
	return append(frame, '\n')
}

func TestHostCompanionCredentialFrame(t *testing.T) {
	valid := credentialFixture(t)
	access, err := initializationAccess(valid)
	if err != nil {
		t.Fatal(err)
	}
	password, certificate, err := access.Read()
	if err != nil || password != strings.Repeat("private-fixture", 3) || len(certificate) == 0 {
		t.Fatal("credential changed")
	}
	access.Close()
	for _, raw := range []string{
		`{}`, `null`, `[]`, string(valid) + `{}`,
		strings.Replace(string(valid), `"protocol":1`, `"protocol":1,"protocol":1`, 1),
		strings.Replace(string(valid), `"protocol":1`, `"Protocol":1`, 1),
		strings.Replace(string(valid), `"protocol":1`, `"protocol":2`, 1),
		strings.Replace(string(valid), `"protocol":1`, `"protocol":null`, 1),
		strings.Replace(string(valid), `"protocol":1`, `"protocol":1,"path":"/tmp/unowned"`, 1),
		`{"protocol":1,"password":"short","certificate":"AA=="}`,
	} {
		if value, err := initializationAccess([]byte(raw)); value != nil || err == nil || err.Error() != "HOST_INIT_INVALID" {
			t.Fatal("invalid initialization admitted", err)
		}
	}
}

func TestHostCompanionMalformedAndOversizedInputNeverStarts(t *testing.T) {
	for _, raw := range []string{"", `{}`, "{}\n", strings.Repeat("x", initializationLimit+1) + "\n"} {
		output := &bufferOutput{}
		err := Run(context.Background(), io.NopCloser(strings.NewReader(raw)), output, t.TempDir(), 2, nil)
		if err == nil || err.Error() != "HOST_INIT_INVALID" || output.Len() != 0 {
			t.Fatal("malformed stream admitted or leaked output", err)
		}
	}
}

func TestHostCompanionCancellationJoinsInitializationReader(t *testing.T) {
	input, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, input, &bufferOutput{}, "unused", 2, nil) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("initialization read survived cancellation")
	}
	if _, err := writer.Write([]byte("must not be read")); err == nil {
		t.Fatal("input remained open")
	}
}

func TestHostCompanionBlockedOutputIsCancelledAndJoined(t *testing.T) {
	reader, output := io.Pipe()
	defer reader.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- writeMessage(ctx, output, map[string]string{"type": "listening"}) }()
	cancel()
	select {
	case err := <-done:
		if err == nil || err.Error() != "HOST_CHANNEL_UNAVAILABLE" {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("output write survived owner cancellation")
	}
}
