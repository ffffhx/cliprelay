//go:build darwin && cgo

package hostclipboard

import (
	"bytes"
	"context"
	"encoding/base64"
	"image/png"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func TestNativeNamedPasteboardTextAndImage(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	a := nativeAccess{name: "org.cliprelay.ci." + strconv.FormatInt(time.Now().UnixNano(), 10)}
	if err := a.Available(); err != nil {
		t.Fatal("Native CI requires an active graphical session:", err)
	}
	exchange := New(a)
	for index, payload := range []Payload{writeRequest().Payload, pngPayload(t)} {
		r := writeRequest()
		r.ID = strconv.Itoa(index) + r.ID[1:]
		r.Payload = payload
		if got := exchange.Handle(context.Background(), r); !got.OK {
			t.Fatal(got)
		}
		got := exchange.Handle(context.Background(), Request{Op: "read", Owner: r.Owner})
		if !got.OK || got.Kind != payload.Kind {
			t.Fatal(got)
		}
		if payload.Kind == "text" {
			if got.Text != payload.Text {
				t.Fatal("text changed")
			}
		} else {
			raw, err := base64.StdEncoding.DecodeString(got.Data)
			if err != nil {
				t.Fatal(err)
			}
			image, err := png.Decode(bytes.NewReader(raw))
			if err != nil || image.Bounds().Dx() != 2 || image.Bounds().Dy() != 3 {
				t.Fatal("native PNG did not decode", err)
			}
			r, g, b, a := image.At(1, 2).RGBA()
			if r == 0 || g != 0 || b != 0 || a == 0 || a == 65535 {
				t.Fatal("native PNG pixel changed")
			}
		}
	}
}
