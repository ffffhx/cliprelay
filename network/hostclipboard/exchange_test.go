package hostclipboard

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"
)

type memoryAccess struct {
	value         Payload
	reads, writes int
	unavailable   error
	afterRead     func()
}

func (a *memoryAccess) Available() error { return a.unavailable }
func (a *memoryAccess) Read() (Payload, error) {
	a.reads++
	if a.afterRead != nil {
		a.afterRead()
	}
	return a.value, nil
}
func (a *memoryAccess) Write(value Payload) error { a.writes++; a.value = value; return nil }
func writeRequest() Request {
	return Request{Op: "write", Owner: strings.Repeat("a", 64), ID: strings.Repeat("1", 32), Payload: Payload{Kind: "text", Text: "中文\nclipboard 😀"}}
}
func pngPayload(t *testing.T) Payload {
	t.Helper()
	value := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	value.Set(1, 2, color.NRGBA{R: 255, A: 128})
	var raw bytes.Buffer
	if err := png.Encode(&raw, value); err != nil {
		t.Fatal(err)
	}
	return Payload{Kind: "png", Data: base64.StdEncoding.EncodeToString(raw.Bytes())}
}

func TestExchangeRoundTrip(t *testing.T) {
	for _, payload := range []Payload{writeRequest().Payload, pngPayload(t)} {
		a := &memoryAccess{}
		exchange := New(a)
		request := writeRequest()
		request.Payload = payload
		if got := exchange.Handle(context.Background(), request); !got.OK {
			t.Fatal(got)
		}
		got := exchange.Handle(context.Background(), Request{Op: "read", Owner: request.Owner})
		if !got.OK || got.Payload != payload || a.writes != 1 || a.reads != 1 {
			t.Fatal(got, a)
		}
	}
}

func TestExchangeLostReplyDoesNotReplaceNewerClipboard(t *testing.T) {
	a := &memoryAccess{}
	exchange := New(a)
	request := writeRequest()
	if !exchange.Handle(context.Background(), request).OK {
		t.Fatal("write failed")
	}
	a.value = Payload{Kind: "text", Text: "newer local content"}
	if !exchange.Handle(context.Background(), request).OK || a.writes != 1 || a.value.Text != "newer local content" {
		t.Fatal("replayed write")
	}
	request.Text = "different"
	if got := exchange.Handle(context.Background(), request); got.Code != "CLIPBOARD_ID_CONFLICT" || a.writes != 1 {
		t.Fatal(got)
	}
	request.Owner = strings.Repeat("b", 64)
	if !exchange.Handle(context.Background(), request).OK || a.writes != 2 {
		t.Fatal("owner namespace collided")
	}
}

func TestExchangeValidationPrecedesNativeAccess(t *testing.T) {
	valid := writeRequest()
	cases := map[string]func(*Request){
		"bad owner": func(r *Request) { r.Owner = "x" }, "bad id": func(r *Request) { r.ID = "x" },
		"unknown operation": func(r *Request) { r.Op = "watch" }, "read with fields": func(r *Request) { r.Op = "read" },
		"empty": func(r *Request) { r.Text = "" }, "nul": func(r *Request) { r.Text = "a\x00b" },
		"invalid utf8": func(r *Request) { r.Text = string([]byte{255}) },
		"mixed":        func(r *Request) { r.Data = "YWJj" }, "oversized text": func(r *Request) { r.Text = strings.Repeat("a", TextLimit+1) },
		"png header only": func(r *Request) {
			r.Payload = pngPayload(t)
			raw, _ := base64.StdEncoding.DecodeString(r.Data)
			r.Data = base64.StdEncoding.EncodeToString(raw[:33])
		},
		"invalid png": func(r *Request) { r.Payload = Payload{Kind: "png", Data: "YWJj"} },
		"file":        func(r *Request) { r.Payload = Payload{Kind: "file", Text: "/etc/passwd"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			a := &memoryAccess{}
			r := valid
			mutate(&r)
			got := New(a).Handle(context.Background(), r)
			if got.OK || a.writes != 0 || a.reads != 0 {
				t.Fatal(got, a)
			}
		})
	}
}

func TestExchangeWithdrawnAccessDiscardsRead(t *testing.T) {
	for _, mode := range []string{"locked", "cancelled", "before"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a := &memoryAccess{value: writeRequest().Payload}
			if mode == "before" {
				a.unavailable = errors.New("CLIPBOARD_LOCKED")
			} else {
				a.afterRead = func() {
					if mode == "locked" {
						a.unavailable = errors.New("CLIPBOARD_LOCKED")
					} else {
						cancel()
					}
				}
			}
			got := New(a).Handle(ctx, Request{Op: "read", Owner: writeRequest().Owner})
			if got.OK || got.Payload != (Payload{}) {
				t.Fatal(got)
			}
		})
	}
}

func TestExchangeEmptyBoundsAndSanitizedErrors(t *testing.T) {
	for _, value := range []Payload{{}, {Kind: "text", Text: strings.Repeat("a", TextLimit+1)}, {Kind: "png", Data: "bad"}} {
		a := &memoryAccess{value: value}
		got := New(a).Handle(context.Background(), Request{Op: "read", Owner: writeRequest().Owner})
		if got.OK || got.Payload != (Payload{}) {
			t.Fatal(got)
		}
	}
	a := &memoryAccess{unavailable: errors.New("private OS error /Users/test/secret")}
	if got := New(a).Handle(context.Background(), writeRequest()); got.Code != "CLIPBOARD_UNAVAILABLE" {
		t.Fatal(got)
	}
	a.unavailable = errors.New("CLIPBOARD_PERMISSION_REQUIRED")
	if got := New(a).Handle(context.Background(), writeRequest()); got.Code != "CLIPBOARD_PERMISSION_REQUIRED" {
		t.Fatal(got)
	}
}

func TestExchangeReceiptMemoryBound(t *testing.T) {
	a := &memoryAccess{}
	exchange := New(a)
	for i := 0; i < 300; i++ {
		r := writeRequest()
		r.ID = fmt.Sprintf("%032x", i)
		if !exchange.Handle(context.Background(), r).OK {
			t.Fatal(i)
		}
	}
	if len(exchange.receipts) != 256 || len(exchange.order) != 256 {
		t.Fatal("unbounded receipts")
	}
}

type bufferCloser struct{ bytes.Buffer }

func (*bufferCloser) Close() error { return nil }
func TestServeFramesAndContentIsolation(t *testing.T) {
	raw, _ := json.Marshal(writeRequest())
	for _, suffix := range []string{"", "garbage\n", "clipboard:{\"unknown\":true}\n", "clipboard:{}trailing\n", "clipboard:{\"text\":\"\xff\"}\n"} {
		t.Run(fmt.Sprintf("suffix-%x", suffix), func(t *testing.T) {
			a := &memoryAccess{}
			output := &bufferCloser{}
			err := Serve(context.Background(), io.NopCloser(strings.NewReader("clipboard:"+string(raw)+"\n"+suffix)), output, a)
			if (suffix == "") != (err == nil) || a.writes != 1 {
				t.Fatal(err, a)
			}
			if strings.Contains(output.String(), writeRequest().Text) || strings.Count(output.String(), "\n") != 1 {
				t.Fatal("content leaked in write receipt")
			}
		})
	}
}

func TestServeCancellationUnblocksOwnedInput(t *testing.T) {
	input, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, input, &bufferCloser{}, &memoryAccess{}) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker retained input after cancellation")
	}
}

func TestServeRejectsOversizedAndPartialFrame(t *testing.T) {
	for _, line := range []string{strings.Repeat("a", MessageLimit) + "\n", "clipboard:{}"} {
		a := &memoryAccess{}
		err := Serve(context.Background(), io.NopCloser(strings.NewReader(line)), &bufferCloser{}, a)
		if err == nil || a.writes != 0 || a.reads != 0 {
			t.Fatal("invalid frame reached clipboard")
		}
	}
}
