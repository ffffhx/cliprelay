package inputfocus

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestDisplayTapUsesCaptureAndLetterbox(t *testing.T) {
	first, second := []byte("first"), []byte("second")
	state := displayFixture(first, second)
	state.Streams[0].Width, state.Streams[0].Height = 1920, 1200
	tap := displayTap{testDisplayInstance, .5, .5, 10, 2, 150}
	x, y, ok := mapDisplayTap(state, displayOwner(first), tap)
	if !ok || x != -960 || y != 540 {
		t.Fatal(x, y, ok)
	}
	tap.Y = .04 // 48 encoded pixels are in the 60-pixel top black bar
	if _, _, ok = mapDisplayTap(state, displayOwner(first), tap); ok {
		t.Fatal("black bar hit a desktop control")
	}
	tap.Y = .5
	tap.Frame = 149
	if _, _, ok = mapDisplayTap(state, displayOwner(first), tap); ok {
		t.Fatal("old decoded frame accepted")
	}
	tap.Frame = 150
	if _, _, ok = mapDisplayTap(state, displayOwner(second), tap); ok {
		t.Fatal("wrong stream owner accepted")
	}
	tap.Generation = 1
	if _, _, ok = mapDisplayTap(state, displayOwner(first), tap); ok {
		t.Fatal("stale generation accepted")
	}
	tap.Generation = 2
	state.Phase = "switching"
	if _, _, ok = mapDisplayTap(state, displayOwner(first), tap); ok {
		t.Fatal("switch-in-progress accepted")
	}
	state.Phase = "active"
	state.Streams[0].Width, state.Streams[0].Height = 1280, 720
	tap.X, tap.Y = 1, 1
	x, y, ok = mapDisplayTap(state, displayOwner(first), tap)
	if !ok || x != -1 || y != 1079 {
		t.Fatal("physical edge mismatch", x, y, ok)
	}
	for _, query := range []string{
		"x=NaN&y=0.5&stream=10&generation=2&frame=150",
		"x=0.5&y=Inf&stream=10&generation=2&frame=150",
		"x=0.5&x=0.4&y=0.5&stream=10&generation=2&frame=150",
		"x=0.5&y=0.5&stream=10&generation=2&frame=-1",
		"x=0.5&y=0.5&stream=10&generation=2",
	} {
		if _, ok := parseDisplayTap(query + "&instance=" + testDisplayInstance); ok {
			t.Fatal("invalid coordinate query accepted", query)
		}
	}
}

func TestDisplayFocusInvalidatesDuringCaptureChange(t *testing.T) {
	clients := filepath.Join(t.TempDir(), "clients.json")
	cert := []byte("paired")
	filePairing(t, clients, cert)
	state := displayFixture(cert, []byte("other"))
	change, probeCalls := false, 0
	h := withDisplays(http.NotFoundHandler(), clients, func(context.Context, bool, *displaySelection) (displayState, error) {
		return state, nil
	}, func(command string) (json.RawMessage, error) {
		probeCalls++
		if command != "focus-point:-960:540" {
			t.Fatal("wrong native point", command)
		}
		if change {
			state.Generation++
		}
		return json.RawMessage(`{"supported":true,"targeted":true,"editable":true,"focusId":"opaque","value":"must not leave UIA"}`), nil
	})
	path := "/v1/display-focus?x=0.5&y=0.5&stream=10&generation=2&frame=150&instance=" + testDisplayInstance
	w := fileCall(h, cert, "GET", path, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"editable":true`) || strings.Contains(w.Body.String(), "must not") {
		t.Fatal(w.Code, w.Body.String())
	}
	change = true
	w = fileCall(h, cert, "GET", path, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":false`) {
		t.Fatal("stale focus escaped", w.Body.String())
	}
	w = fileCall(h, cert, "GET", path, "")
	if probeCalls != 2 || !strings.Contains(w.Body.String(), `"supported":false`) {
		t.Fatal("stale request reached UIA")
	}
	if fileCall(h, nil, "GET", path, "").Code != 403 {
		t.Fatal("unpaired focus request accepted")
	}
}
