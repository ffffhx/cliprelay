package hostterminal

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

// The existing independent xterm oracle can exercise this test executable in
// exactly the same way as the Windows worker's parser probe. No shell is used.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--mouse-modes" {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			data, err := base64.StdEncoding.DecodeString(scanner.Text())
			if err != nil {
				os.Exit(2)
			}
			modes := newMouseModes()
			for _, b := range data {
				modes.Feed([]byte{b})
			}
			fmt.Printf("%d,%d\n", modes.Mode, modes.Format)
		}
		if scanner.Err() != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestMouseModesBoundariesAndOffsets(t *testing.T) {
	m := newMouseModes()
	hidden := "\x1b]title[?1000h\a\x1bP1;2|\a[?1003h\x1b\\\x1b_[?1002h\x1b\\\x1b^[?1000h\x1b\\\x1bX[?1000h\x1b\\\u061b?1000h"
	for _, b := range []byte(hidden) {
		m.Feed([]byte{b})
	}
	if m.Mode != 0 || m.Epoch != 1 || m.Offset != int64(len(hidden)) {
		t.Fatal(m)
	}
	for _, b := range []byte("\u009b?1002;1006h") {
		m.Feed([]byte{b})
	}
	if m.Mode != 1002 || m.Format != 1006 || m.ChangedAt != m.Offset {
		t.Fatal(m)
	}
	m.Feed([]byte("\u009d[?1000l\u009c"))
	if m.Mode != 1002 {
		t.Fatal("OSC payload became a control", m)
	}
	m.Feed([]byte("\x1bP1;2|\x1b[?1002l"))
	if m.Mode != 0 {
		t.Fatal("ESC did not end DCS", m)
	}
	m.Feed([]byte("\x1b]title\u009b?1003h"))
	if m.Mode != 1003 {
		t.Fatal("C1 CSI did not end OSC", m)
	}
}

func TestMouseModesResetOverflowAndFragmentation(t *testing.T) {
	cases := []struct {
		data         string
		mode, format int
	}{
		{"\x1b[?1002;1006h\x1b[!p", 1002, 1006},
		{"\x1b[?1002;1006h\x1b[?1002;1006s\x1b[?1000l\x1b[?1006l\x1b[?1002;1006r", 1002, 1006},
		{"\x1b[?1000;h", 1000, 0},
		{"\x1b[?1002;1006h\x1b[?" + strings.Repeat("1", 300) + "h", -1, -1},
		{"\x1b[?" + strings.Repeat("1;", 33) + "1000h", -1, -1},
		{"\x1b[?1002;1006h\x1bc\x1b[?1003h\x1b[?1016h", 1003, 1016},
		{"\x1b[?1001h", 1001, 0},
		{"\x1b[?1002;1006h\x1b[?1003\x18h", 1002, 1006},
		{"\x1b[?1002;1006h\x1b[?1003\xffh", 1002, 1006},
	}
	for i, c := range cases {
		for split := 0; split <= len(c.data); split++ {
			m := newMouseModes()
			m.Feed([]byte(c.data[:split]))
			m.Feed([]byte(c.data[split:]))
			if m.Mode != c.mode || m.Format != c.format || len(m.csi) > 256 || len(m.saved) > 9 {
				t.Fatalf("case %d split %d: %+v", i, split, m)
			}
		}
	}
}

func TestMouseEncoding(t *testing.T) {
	cases := []struct {
		mode, format                   int
		action                         string
		button, modifiers, column, row int
		want, code                     string
	}{
		{1002, 1006, "press", 2, 28, 5, 7, "\x1b[<30;5;7M", ""},
		{1002, 1006, "move", 2, 16, 6, 8, "\x1b[<50;6;8M", ""},
		{1003, 1016, "move", 3, 0, 1234, 567, "\x1b[<35;1234;567M", ""},
		{1000, 1006, "release", 1, 8, 5, 7, "\x1b[<9;5;7m", ""},
		{1000, 1015, "wheel", 3, 4, 5, 7, "\x1b[103;5;7M", ""},
		{1000, 1005, "press", 0, 0, 240, 7, string([]byte{27, 91, 77, 32, 196, 144, 39}), ""},
		{9, 0, "press", 2, 28, 5, 7, string([]byte{27, 91, 77, 34, 37, 39}), ""},
		{1000, 0, "press", 0, 0, 224, 7, "", "TERMINAL_BAD_REQUEST"},
		{1000, 1006, "move", 0, 0, 5, 7, "", "TERMINAL_MOUSE_MODE"},
		{9, 0, "release", 0, 0, 5, 7, "", "TERMINAL_MOUSE_MODE"},
		{1003, 1016, "press", 0, 0, 65536, 1, "", "TERMINAL_BAD_REQUEST"},
	}
	for _, c := range cases {
		got, err := encodeMouse(c.mode, c.format, c.action, c.button, c.modifiers, c.column, c.row)
		if c.code != "" {
			mouseError(t, err, c.code)
		} else if err != nil || string(got) != c.want {
			t.Fatalf("%+v: %q %v", c, got, err)
		}
	}
}

type mouseFixture struct {
	t   *testing.T
	now int64
	q   *InputQueue
}

func mouseTest(t *testing.T) *mouseFixture {
	t.Helper()
	f := &mouseFixture{t: t, now: 100}
	f.q = NewInputQueue(func() int64 { return f.now }, 100, 30)
	f.output("\x1b[?1002;1006h")
	return f
}
func (f *mouseFixture) output(text string) { f.q.Observe([]byte(text), func([]byte) {}) }
func (f *mouseFixture) command(sequence int64, action string) MouseCommand {
	c := MouseCommand{Sequence: sequence, Action: action, Epoch: f.q.State().Epoch, Gesture: 1, Column: 5, Row: 7}
	if action == "renew" || action == "cancel" {
		c.Column, c.Row = 0, 0
	}
	return c
}
func (f *mouseFixture) send(c MouseCommand) {
	f.t.Helper()
	if err := f.q.Mouse(c); err != nil {
		f.t.Fatal(c, err)
	}
}
func (f *mouseFixture) complete(item *InputItem) {
	f.t.Helper()
	if err := f.q.Complete(item); err != nil {
		f.t.Fatal(err)
	}
}
func (f *mouseFixture) write(want string) {
	f.t.Helper()
	item := f.q.Begin()
	if item == nil {
		f.t.Fatal("missing input", f.q.State())
	}
	if string(item.Data) != want {
		f.t.Fatalf("input %q != %q", item.Data, want)
	}
	f.complete(item)
}
func mouseError(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || err.Error() != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestMouseQueuedExpiryAndRawBounds(t *testing.T) {
	f := mouseTest(t)
	for n := int64(1); n <= 8; n++ {
		if !f.q.Queue(make([]byte, 4096), n, false) {
			t.Fatal("raw capacity")
		}
	}
	if f.q.Queue([]byte{0}, 9, false) {
		t.Fatal("raw capacity exceeded")
	}
	f.send(f.command(1, "press"))
	f.now += 1500
	if f.q.State().Outcome != "expired" {
		t.Fatal(f.q.State())
	}
	for n := int64(1); n <= 8; n++ {
		item := f.q.Begin()
		if item == nil || item.mouse || item.sequence != n {
			t.Fatal("expired press escaped", item)
		}
		f.complete(item)
	}
	if f.q.Begin() != nil || f.q.State().WrittenSequence != 0 || f.q.KeyboardWritten() != 8 {
		t.Fatal(f.q.State())
	}
	body := []byte("whole paste")
	if !f.q.Queue(body, 9, true) {
		t.Fatal("paste")
	}
	body[0] = 'X'
	item := f.q.Begin()
	if !item.Paste || string(item.Data) != "whole paste" {
		t.Fatal("caller mutated queued paste")
	}
	f.complete(item)
}
func TestMouseWrittenDragExpiryAndReplay(t *testing.T) {
	f := mouseTest(t)
	f.send(f.command(1, "press"))
	f.write("\x1b[<0;5;7M")
	move := f.command(2, "move")
	move.Column, move.Row = 6, 8
	f.send(move)
	f.write("\x1b[<32;6;8M")
	f.now += 1500
	if f.q.State().Phase != "expired" {
		t.Fatal(f.q.State())
	}
	f.write("\x1b[<0;6;8m")
	if s := f.q.State(); s.Buttons != 0 || s.WrittenSequence != 2 {
		t.Fatal(s)
	}
	f.send(move)
	if f.q.State().RemainingMs != 0 || f.q.Begin() != nil {
		t.Fatal("replay revived gesture")
	}
	mouseError(t, f.q.Mouse(f.command(3, "renew")), "TERMINAL_MOUSE_GESTURE")
	c := f.command(3, "press")
	c.Gesture = 2
	f.send(c)
}
func TestMouseLostReceiptsCannotExtendLease(t *testing.T) {
	f := mouseTest(t)
	press := f.command(1, "press")
	f.send(press)
	f.write("\x1b[<0;5;7M")
	f.now += 1000
	f.send(press)
	if f.q.State().RemainingMs != 500 {
		t.Fatal("press replay extended lease")
	}
	renew := f.command(2, "renew")
	f.send(renew)
	f.now += 1400
	f.send(renew)
	if f.q.State().RemainingMs != 100 {
		t.Fatal("renew replay extended lease")
	}
	changed := renew
	changed.Action = "cancel"
	mouseError(t, f.q.Mouse(changed), "TERMINAL_MOUSE_CONFLICT")
	f.now += 100
	if f.q.State().Phase != "expired" {
		t.Fatal(f.q.State())
	}
	mouseError(t, f.q.Mouse(f.command(3, "press")), "TERMINAL_BUSY")
	f.write("\x1b[<0;5;7m")
	mouseError(t, f.q.Mouse(f.command(3, "press")), "TERMINAL_MOUSE_GESTURE")
}
func TestMouseCancelReservesPriorityUnderSaturation(t *testing.T) {
	f := mouseTest(t)
	f.send(f.command(1, "press"))
	f.write("\x1b[<0;5;7M")
	for n := int64(1); n <= 8; n++ {
		if !f.q.Queue(make([]byte, 4096), n, false) {
			t.Fatal("raw capacity")
		}
	}
	for n := int64(2); n <= 65; n++ {
		f.send(f.command(n, "move"))
	}
	mouseError(t, f.q.Mouse(f.command(66, "move")), "TERMINAL_BUSY")
	if f.q.State().AcceptedSequence != 65 {
		t.Fatal("busy consumed sequence")
	}
	f.send(f.command(66, "cancel"))
	f.write("\x1b[<0;5;7m")
	if s := f.q.State(); s.AcceptedSequence != 66 || s.WrittenSequence != 1 || s.Buttons != 0 {
		t.Fatal(s)
	}
	if item := f.q.Begin(); item == nil || item.mouse {
		t.Fatal("cancelled move survived")
	}
}
func TestMouseExpiryDuringNativeWriteAndStall(t *testing.T) {
	f := mouseTest(t)
	f.send(f.command(1, "press"))
	item := f.q.Begin()
	f.now += 1600
	if s := f.q.State(); s.Phase != "expired" || s.Buttons != 0 {
		t.Fatal(s)
	}
	f.complete(item)
	if f.q.State().Buttons != 1 {
		t.Fatal("late native press lost")
	}
	f.write("\x1b[<0;5;7m")
	g := mouseTest(t)
	g.send(g.command(1, "press"))
	g.q.Begin()
	g.now += 5001
	if !g.q.AbortRequired() || g.q.State().WrittenSequence != 0 || g.q.Begin() != nil {
		t.Fatal("stalled uncertain write continued")
	}
	mouseError(t, g.q.Mouse(g.command(2, "renew")), "TERMINAL_CLOSED")
}
func TestMouseModeChangeAndResizeDoNotResurrectInput(t *testing.T) {
	t.Run("disable", func(t *testing.T) {
		f := mouseTest(t)
		f.send(f.command(1, "press"))
		f.write("\x1b[<0;5;7M")
		old := f.command(2, "move")
		f.send(old)
		f.output("\x1b[?1002l")
		if f.q.Begin() != nil || f.q.State().Buttons != 0 {
			t.Fatal("obsolete release entered shell")
		}
		old.Sequence = 3
		mouseError(t, f.q.Mouse(old), "TERMINAL_MOUSE_MODE")
		f.output("\x1b[?1003h")
		c := f.command(3, "press")
		c.Gesture = 2
		f.send(c)
		f.write("\x1b[<0;5;7M")
	})
	t.Run("resize-in-flight", func(t *testing.T) {
		f := mouseTest(t)
		old := f.command(1, "press")
		old.Column, old.Row = 90, 25
		f.send(old)
		item := f.q.Begin()
		f.q.Resize(20, 10)
		f.complete(item)
		f.write("\x1b[<0;20;10m")
		old.Sequence = 2
		mouseError(t, f.q.Mouse(old), "TERMINAL_MOUSE_MODE")
	})
	t.Run("resize-after-mode-change", func(t *testing.T) {
		f := mouseTest(t)
		f.send(f.command(1, "press"))
		item := f.q.Begin()
		f.output("\x1b[?1003h")
		f.q.Resize(80, 20)
		f.complete(item)
		if f.q.State().Buttons != 0 || f.q.Begin() != nil {
			t.Fatal("resize resurrected old-mode press")
		}
		c := f.command(2, "press")
		c.Gesture = 2
		f.send(c)
		f.write("\x1b[<0;5;7M")
	})
}
func TestMouseMultipleButtonsAndGestureReentry(t *testing.T) {
	f := mouseTest(t)
	c := f.command(1, "press")
	c.Modifiers = 4
	f.send(c)
	f.write("\x1b[<4;5;7M")
	c = f.command(2, "press")
	c.Button, c.Modifiers = 2, 16
	f.send(c)
	f.write("\x1b[<18;5;7M")
	c = f.command(3, "move")
	c.Button, c.Modifiers, c.Column, c.Row = 2, 16, 6, 8
	f.send(c)
	f.write("\x1b[<50;6;8M")
	f.send(f.command(4, "cancel"))
	f.write("\x1b[<4;5;7m\x1b[<18;6;8m")
	g := mouseTest(t)
	g.send(g.command(1, "press"))
	g.send(g.command(2, "release"))
	c = g.command(3, "press")
	c.Gesture = 2
	mouseError(t, g.q.Mouse(c), "TERMINAL_BUSY")
	g.write("\x1b[<0;5;7M")
	g.write("\x1b[<0;5;7m")
	g.send(c)
	g.write("\x1b[<0;5;7M")
}
func TestMouseHoverWheelAndStop(t *testing.T) {
	f := mouseTest(t)
	f.output("\x1b[?1003h")
	c := f.command(1, "move")
	c.Gesture, c.Button = 0, 3
	f.send(c)
	f.write("\x1b[<35;5;7M")
	c = f.command(2, "wheel")
	c.Gesture, c.Button = 0, 1
	f.send(c)
	f.now += 1500
	if f.q.Begin() != nil || f.q.State().WrittenSequence != 1 || f.q.State().Outcome != "expired" {
		t.Fatal("expired wheel was written")
	}
	f.send(f.command(3, "press"))
	item := f.q.Begin()
	f.q.Stop()
	f.complete(item)
	if s := f.q.State(); s.Phase != "closed" || s.Buttons != 0 || s.WrittenSequence != 3 {
		t.Fatal(s)
	}
	if f.q.Queue([]byte("late"), 1, false) || f.q.Begin() != nil {
		t.Fatal("stopped queue reopened")
	}
}
func TestMouseConcurrentOutputResizeAndState(t *testing.T) {
	q := NewInputQueue(func() int64 { return 100 }, 100, 30)
	var group sync.WaitGroup
	group.Add(3)
	go func() {
		defer group.Done()
		for i := 0; i < 500; i++ {
			q.Observe([]byte("\x1b[?1002;1006h"), func([]byte) {})
		}
	}()
	go func() {
		defer group.Done()
		for i := 0; i < 500; i++ {
			q.Resize(80, 24)
		}
	}()
	go func() {
		defer group.Done()
		for i := 0; i < 500; i++ {
			q.State()
			q.Begin()
			q.AbortRequired()
		}
	}()
	group.Wait()
	q.Stop()
	if q.State().Phase != "closed" {
		t.Fatal("concurrent stop lost")
	}
}
