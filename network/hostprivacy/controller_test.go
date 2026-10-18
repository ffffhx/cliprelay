package hostprivacy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

const leaseA = "0123456789abcdef0123456789abcdef"
const leaseB = "fedcba9876543210fedcba9876543210"

type fakeDesktop struct {
	prepared, shown, hidden int
	healthy                 bool
	identity                Identity
	prepare                 func()
	hideError               error
}

func (d *fakeDesktop) Prepare() (Identity, error) {
	d.prepared++
	if d.prepare != nil {
		d.prepare()
	}
	return d.identity, nil
}
func (d *fakeDesktop) Show() error   { d.shown++; return nil }
func (d *fakeDesktop) Hide() error   { d.hidden++; return d.hideError }
func (d *fakeDesktop) Healthy() bool { return d.healthy }
func fixture() (*Controller, *fakeDesktop, *time.Time) {
	now := time.Now()
	desktop := &fakeDesktop{healthy: true, identity: Identity{PID: 123, BirthSec: 1, Windows: []Window{{ID: 41, Display: 2}}}}
	return New(desktop, func() time.Time { return now }), desktop, &now
}
func call(t *testing.T, c *Controller, op, lease string) Response {
	t.Helper()
	value, err := c.Handle(Request{Op: op, Lease: lease})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestPrepareNeverRevealsAndActivationDoesNotExtendLease(t *testing.T) {
	c, d, now := fixture()
	prepared := call(t, c, "prepare", leaseA)
	if !prepared.OK || !prepared.Prepared || prepared.Active || d.shown != 0 || prepared.Identity == nil || prepared.ExpiresMs != 15000 {
		t.Fatalf("invalid preparation: %+v", prepared)
	}
	deadline := c.Deadline()
	*now = now.Add(4 * time.Second)
	active := call(t, c, "activate", leaseA)
	if !active.OK || !active.Active || active.ExpiresMs != 11000 || d.shown != 1 || c.Deadline() != deadline {
		t.Fatalf("invalid activation: %+v", active)
	}
	call(t, c, "prepare", leaseA)
	call(t, c, "activate", leaseA)
	if c.Deadline() != deadline || d.prepared != 1 || d.shown != 1 {
		t.Fatal("replay extended or repeated activation")
	}
}

func TestForeignLeaseCannotRevealRenewOrRemoveOwnedMasks(t *testing.T) {
	c, d, _ := fixture()
	call(t, c, "prepare", leaseA)
	for _, op := range []string{"prepare", "activate", "renew", "stop"} {
		value := call(t, c, op, leaseB)
		if value.OK || value.Code != "PRIVACY_BUSY" || value.Identity != nil || value.Lease != "" {
			t.Fatalf("foreign %s: %+v", op, value)
		}
	}
	if d.shown != 0 || d.hidden != 0 {
		t.Fatal("foreign lease changed visible state")
	}
}

func TestExpiredPreparationCannotRevealOrBeRenewed(t *testing.T) {
	for _, op := range []string{"activate", "renew", "prepare"} {
		t.Run(op, func(t *testing.T) {
			c, d, now := fixture()
			call(t, c, "prepare", leaseA)
			*now = now.Add(Lifetime)
			value := call(t, c, op, leaseA)
			if value.OK || value.Code != "PRIVACY_EXPIRED" || d.shown != 0 || d.hidden != 1 || !c.Deadline().IsZero() {
				t.Fatalf("expired request: %+v", value)
			}
		})
	}
}

func TestOnlyHealthyActiveLeaseCanRenew(t *testing.T) {
	c, d, now := fixture()
	call(t, c, "prepare", leaseA)
	if call(t, c, "renew", leaseA).OK {
		t.Fatal("prepared masks cannot renew")
	}
	call(t, c, "activate", leaseA)
	*now = now.Add(5 * time.Second)
	if value := call(t, c, "renew", leaseA); !value.OK || value.ExpiresMs != 15000 {
		t.Fatalf("healthy renew: %+v", value)
	}
	d.healthy = false
	if value := call(t, c, "renew", leaseA); value.OK || value.Code != "PRIVACY_DESKTOP_UNAVAILABLE" || d.hidden != 1 {
		t.Fatalf("changed desktop: %+v", value)
	}
	if value := call(t, c, "status", ""); value.Active || value.Prepared || value.Identity != nil || value.Lease != "" {
		t.Fatalf("stale identity retained: %+v", value)
	}
}

func TestNativePreparationCannotBlockIndependentDeadlineReader(t *testing.T) {
	c, d, _ := fixture()
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	d.prepare = func() { close(entered); <-release }
	go func() { defer close(done); _, _ = c.Handle(Request{Op: "prepare", Lease: leaseA}) }()
	<-entered
	read := make(chan time.Time, 1)
	go func() { read <- c.Deadline() }()
	select {
	case deadline := <-read:
		if deadline.IsZero() {
			t.Error("native call began before watchdog armed")
		}
	case <-time.After(time.Second):
		t.Error("native operation blocked deadline reader")
	}
	close(release)
	<-done
}

func TestInvalidNativeIdentityNeverActivatesAndRestores(t *testing.T) {
	for _, identity := range []Identity{{}, {PID: 123, BirthSec: 1, Windows: []Window{{ID: 1, Display: 2}, {ID: 1, Display: 3}}},
		{PID: 123, BirthSec: 1, Windows: []Window{{ID: 1, Display: 2}, {ID: 3, Display: 2}}}} {
		c, d, _ := fixture()
		d.identity = identity
		if value := call(t, c, "prepare", leaseA); value.OK || value.Identity != nil || d.hidden != 1 || d.shown != 0 {
			t.Fatalf("invalid identity admitted: %+v", value)
		}
	}
}

func TestFailedRestorationDoesNotDisarmProcessDeadline(t *testing.T) {
	c, d, _ := fixture()
	call(t, c, "prepare", leaseA)
	call(t, c, "activate", leaseA)
	deadline := c.Deadline()
	d.hideError = errors.New("native UI unavailable")
	if _, err := c.Handle(Request{Op: "stop", Lease: leaseA}); err == nil || c.Deadline() != deadline {
		t.Fatal("failed native restoration was reported as stopped")
	}
}

type writeBuffer struct{ bytes.Buffer }

func (*writeBuffer) Close() error { return nil }

func TestPrivateProtocolEOFRestoresAndWithdrawsAuthority(t *testing.T) {
	c, d, _ := fixture()
	input := io.NopCloser(strings.NewReader(`{"op":"prepare","lease":"` + leaseA + `"}` + "\n" + `{"op":"activate","lease":"` + leaseA + `"}` + "\n"))
	output := new(writeBuffer)
	if err := Serve(context.Background(), input, output, c); err != nil {
		t.Fatal(err)
	}
	if d.shown != 1 || d.hidden != 1 || !c.Deadline().IsZero() {
		t.Fatal("EOF retained visible authority")
	}
	select {
	case <-c.Withdrawn():
	default:
		t.Fatal("process guardian not notified")
	}
}

func TestPrivateProtocolRejectsUnknownFieldsExtraJSONAndOversize(t *testing.T) {
	for _, line := range []string{`{"op":"prepare","lease":"` + leaseA + `","windows":[1]}`, `{"op":"status"}{"op":"activate"}`, strings.Repeat("x", 1100)} {
		c, d, _ := fixture()
		err := Serve(context.Background(), io.NopCloser(strings.NewReader(line+"\n")), new(writeBuffer), c)
		if err == nil || d.prepared != 0 || d.shown != 0 {
			t.Fatal("malformed private command admitted")
		}
	}
}
