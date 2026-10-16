package hostclipboard

import (
	"context"
	"strconv"
	"testing"
)

type versionedMemory struct {
	memoryAccess
	version           int
	beforeConditional func()
}

func (a *versionedMemory) Version() (string, error) { return strconv.Itoa(a.version), nil }
func (a *versionedMemory) Write(p Payload) error    { a.version++; return a.memoryAccess.Write(p) }
func (a *versionedMemory) WriteIfVersion(p Payload, version string) (bool, error) {
	if a.beforeConditional != nil {
		a.beforeConditional()
	}
	if strconv.Itoa(a.version) != version {
		return false, nil
	}
	return true, a.Write(p)
}
func observed(t *testing.T, e *Exchange, revision string) Response {
	t.Helper()
	result := e.Handle(context.Background(), Request{Op: "observe", Owner: writeRequest().Owner, Revision: revision})
	if !result.OK || !ownerPattern.MatchString(result.Revision) || result.Changed == nil {
		t.Fatal(result)
	}
	return result
}
func TestObserveReadsOnlyChangedContent(t *testing.T) {
	a := &versionedMemory{}
	e := New(a)
	first := observed(t, e, "")
	if first.Kind != "empty" || !*first.Changed || a.reads != 1 {
		t.Fatal(first, a.reads)
	}
	same := observed(t, e, first.Revision)
	if *same.Changed || same.Payload != (Payload{}) || a.reads != 1 {
		t.Fatal("unchanged observation read clipboard", same, a.reads)
	}
	if err := a.Write(writeRequest().Payload); err != nil {
		t.Fatal(err)
	}
	changed := observed(t, e, first.Revision)
	if !*changed.Changed || changed.Revision == first.Revision || changed.Payload != writeRequest().Payload || a.reads != 2 {
		t.Fatal(changed)
	}
}
func TestConditionalWriteRejectsLateChangeAndLostReplyDoesNotReplay(t *testing.T) {
	a := &versionedMemory{}
	e := New(a)
	first := observed(t, e, "")
	r := writeRequest()
	r.Expect = first.Revision
	if got := e.Handle(context.Background(), r); !got.OK {
		t.Fatal(got)
	}
	a.Write(Payload{Kind: "text", Text: "later local copy"})
	if got := e.Handle(context.Background(), r); !got.OK || a.writes != 2 || a.value.Text != "later local copy" {
		t.Fatal("duplicate replaced clipboard", got)
	}
	r.ID = "22222222222222222222222222222222"
	if got := e.Handle(context.Background(), r); got.Code != "CLIPBOARD_CHANGED" || a.writes != 2 {
		t.Fatal("stale write accepted", got)
	}
	r.Expect = observed(t, e, "").Revision
	a.beforeConditional = func() { a.version++; a.value = Payload{Kind: "text", Text: "changed during preparation"} }
	if got := e.Handle(context.Background(), r); got.Code != "CLIPBOARD_CHANGED" || a.writes != 2 {
		t.Fatal("native comparison not used", got)
	}
}
func TestObserveRejectsChangeDuringReadAndWorkerEpochIsFresh(t *testing.T) {
	a := &versionedMemory{memoryAccess: memoryAccess{value: writeRequest().Payload}}
	e := New(a)
	first := observed(t, e, "")
	a.afterRead = func() { a.version++ }
	if got := e.Handle(context.Background(), Request{Op: "observe", Owner: writeRequest().Owner}); got.Code != "CLIPBOARD_CHANGED" || got.Payload != (Payload{}) {
		t.Fatal(got)
	}
	a.afterRead = nil
	r := writeRequest()
	r.Expect = first.Revision
	if got := New(a).Handle(context.Background(), r); got.Code != "CLIPBOARD_CHANGED" || a.writes != 0 {
		t.Fatal("old worker token accepted", got)
	}
}
func TestVersionFieldsAreScopedAndUnsupportedAccessNeverWrites(t *testing.T) {
	a := &memoryAccess{}
	e := New(a)
	if got := e.Handle(context.Background(), Request{Op: "observe", Owner: writeRequest().Owner}); got.Code != "CLIPBOARD_SYNC_UNSUPPORTED" {
		t.Fatal(got)
	}
	r := writeRequest()
	r.Expect = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if got := e.Handle(context.Background(), r); got.Code != "CLIPBOARD_SYNC_UNSUPPORTED" || a.writes != 0 {
		t.Fatal(got)
	}
	for _, r := range []Request{
		{Op: "read", Owner: writeRequest().Owner, Revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{Op: "observe", Owner: writeRequest().Owner, Revision: "bad"},
		{Op: "write", Owner: writeRequest().Owner, ID: writeRequest().ID, Payload: writeRequest().Payload, Expect: "bad"},
	} {
		if got := e.Handle(context.Background(), r); got.Code != "CLIPBOARD_BAD_REQUEST" {
			t.Fatal(got)
		}
	}
}
