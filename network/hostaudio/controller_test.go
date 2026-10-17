package hostaudio

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

const leaseA = "0123456789abcdef0123456789abcdef"
const leaseB = "abcdef0123456789abcdef0123456789"

type fakeOutput struct {
	active              bool
	starts, stops       int
	startFail, stopFail bool
	start               func()
}

func (*fakeOutput) Outputs() (int, error) { return 2, nil }
func (f *fakeOutput) Start() error {
	f.starts++
	f.active = true
	if f.start != nil {
		f.start()
	}
	if f.startFail {
		return errors.New("start")
	}
	return nil
}
func (f *fakeOutput) Healthy() bool { return f.active }
func (f *fakeOutput) Stop() error {
	f.stops++
	if f.stopFail {
		return errors.New("stop")
	}
	f.active = false
	return nil
}
func fixture() (*Controller, *fakeOutput, *time.Time) {
	now := time.Now()
	out := &fakeOutput{}
	return New(out, func() time.Time { return now }), out, &now
}
func call(t *testing.T, c *Controller, op, lease string) Response {
	t.Helper()
	v, err := c.Handle(Request{op, lease})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestReadOnlyStatusAndInvalidCommands(t *testing.T) {
	c, out, _ := fixture()
	v := call(t, c, "status", "")
	if !v.OK || !v.Supported || v.Active || out.starts != 0 {
		t.Fatal(v)
	}
	for _, q := range []Request{{"status", leaseA}, {"start", ""}, {"renew", "bad"}, {"unknown", leaseA}} {
		if v := call(t, c, q.Op, q.Lease); v.OK || v.Code != "AUDIO_BAD_REQUEST" {
			t.Fatal(q, v)
		}
	}
	if out.starts != 0 {
		t.Fatal("invalid request started audio")
	}
}
func TestStartReplayRenewAndMatchingStop(t *testing.T) {
	c, out, now := fixture()
	v := call(t, c, "start", leaseA)
	if !v.Active || v.Lease != leaseA || v.ExpiresMs != 15000 {
		t.Fatal(v)
	}
	*now = now.Add(5 * time.Second)
	v = call(t, c, "start", leaseA)
	if v.ExpiresMs != 10000 || out.starts != 1 {
		t.Fatal("start replay renewed lease", v)
	}
	v = call(t, c, "renew", leaseA)
	if v.ExpiresMs != 15000 || out.starts != 1 {
		t.Fatal(v)
	}
	v = call(t, c, "stop", leaseA)
	if !v.OK || v.Active || out.active || !c.Deadline().IsZero() {
		t.Fatal(v)
	}
	if v = call(t, c, "start", leaseA); v.OK || v.Code != "AUDIO_EXPIRED" {
		t.Fatal("late start resurrected lease", v)
	}
}
func TestOtherLeaseCannotInterrupt(t *testing.T) {
	c, out, _ := fixture()
	call(t, c, "start", leaseA)
	for _, op := range []string{"start", "renew", "stop"} {
		if v := call(t, c, op, leaseB); v.Code != "AUDIO_BUSY" || !out.active {
			t.Fatal(op, v)
		}
	}
}
func TestStopBeforeStartRetiresOnlyThatLease(t *testing.T) {
	c, out, _ := fixture()
	call(t, c, "stop", leaseA)
	if v := call(t, c, "start", leaseA); v.Code != "AUDIO_EXPIRED" || out.starts != 0 {
		t.Fatal(v)
	}
	if v := call(t, c, "start", leaseB); !v.Active {
		t.Fatal(v)
	}
}
func TestExpiryAndLostTapRestoreWithoutRenewing(t *testing.T) {
	for _, reason := range []string{"expiry", "lost-tap"} {
		t.Run(reason, func(t *testing.T) {
			c, out, now := fixture()
			call(t, c, "start", leaseA)
			if reason == "expiry" {
				*now = now.Add(Lifetime)
			} else {
				out.active = false
			}
			v := call(t, c, "renew", leaseA)
			if v.OK || v.Code != "AUDIO_EXPIRED" || out.active || out.stops != 1 || !c.Deadline().IsZero() {
				t.Fatal(v)
			}
		})
	}
}
func TestPartialStartFailureRestoresAndRetires(t *testing.T) {
	c, out, _ := fixture()
	out.startFail = true
	v := call(t, c, "start", leaseA)
	if v.OK || out.active || out.stops != 1 || !c.Deadline().IsZero() {
		t.Fatal(v)
	}
	if v = call(t, c, "start", leaseA); v.Code != "AUDIO_EXPIRED" {
		t.Fatal(v)
	}
}
func TestStartCannotOutliveOriginalDeadline(t *testing.T) {
	c, out, now := fixture()
	out.start = func() { *now = now.Add(Lifetime) }
	v := call(t, c, "start", leaseA)
	if v.OK || v.Code != "AUDIO_EXPIRED" || out.active || out.stops != 1 {
		t.Fatal(v)
	}
}
func TestFailedRestoreNeverClearsWatchdog(t *testing.T) {
	c, out, _ := fixture()
	call(t, c, "start", leaseA)
	deadline := c.Deadline()
	out.stopFail = true
	if _, err := c.Handle(Request{"stop", leaseA}); err == nil || !out.active || c.Deadline() != deadline {
		t.Fatal("unconfirmed restoration")
	}
	out.stopFail = false
	v := call(t, c, "stop", leaseA)
	if v.Active || out.active || !c.Deadline().IsZero() {
		t.Fatal(v)
	}
}
func TestRetiredCapacityAndExpiry(t *testing.T) {
	c, _, now := fixture()
	for i := 0; i < 256; i++ {
		lease := strings.Repeat("0", 28) + string("0123456789abcdef"[i/16]) + string("0123456789abcdef"[i%16]) + "ff"
		if !call(t, c, "stop", lease).OK {
			t.Fatal(i)
		}
	}
	if v := call(t, c, "start", leaseA); v.Code != "AUDIO_BUSY" {
		t.Fatal(v)
	}
	*now = now.Add(2 * time.Minute)
	if v := call(t, c, "start", leaseA); !v.Active {
		t.Fatal(v)
	}
}
func TestPrivateProtocolEOFAndMalformedInputRestore(t *testing.T) {
	for _, line := range []string{"", `audio-mute:{"op":"start","op":"stop","lease":"` + leaseA + `"}` + "\n", `audio-mute:{"Op":"status"}` + "\n", `audio-mute:{"op":"status","extra":1}` + "\n", "bad\n", strings.Repeat("x", 1024)} {
		t.Run(line[:min(len(line), 30)], func(t *testing.T) {
			c, out, _ := fixture()
			call(t, c, "start", leaseA)
			left, right := net.Pipe()
			done := make(chan error, 1)
			go func() { done <- Serve(context.Background(), left, left, c) }()
			if line != "" {
				_ = right.SetWriteDeadline(time.Now().Add(time.Second))
				_, _ = io.WriteString(right, line)
			}
			_ = right.Close()
			select {
			case err := <-done:
				if line == "" && err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("worker did not stop")
			}
			if out.active || out.stops != 1 || !c.Deadline().IsZero() {
				t.Fatal("EOF retained mute")
			}
		})
	}
}
