package hostterminal

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

type fakeProcess struct {
	mu                        sync.Mutex
	state                     ProcessState
	busy, closing, delayClose bool
	writes                    [][]byte
	sequences                 []int64
	output                    func([]byte)
	done                      chan struct{}
}

func (p *fakeProcess) Queue(data []byte, sequence int64, paste bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.busy || p.closing {
		return false
	}
	p.writes = append(p.writes, append([]byte(nil), data...))
	p.sequences = append(p.sequences, sequence)
	return true
}
func (p *fakeProcess) Resize(columns, rows int) error { return nil }
func (p *fakeProcess) Status() ProcessState           { p.mu.Lock(); defer p.mu.Unlock(); return p.state }
func (p *fakeProcess) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closing {
		p.closing = true
		if !p.delayClose {
			close(p.done)
		}
	}
}
func (p *fakeProcess) Done() <-chan struct{} { return p.done }

type fixture struct {
	m         *Manager
	clock     int64
	processes []*fakeProcess
	fail      bool
	owners    []string
	nextID    int
}

func setup(t *testing.T) *fixture {
	f := &fixture{owners: []string{strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)}}
	f.m = New(func() int64 { return f.clock }, func(shell string, columns, rows int, output func([]byte)) (Process, error) {
		p := &fakeProcess{output: output, done: make(chan struct{})}
		f.processes = append(f.processes, p)
		if f.fail {
			return p, errors.New("startup failed")
		}
		return p, nil
	})
	f.sync(t, f.owners...)
	t.Cleanup(func() { f.m.Close() })
	return f
}
func (f *fixture) sync(t *testing.T, owners ...string) {
	t.Helper()
	if owners == nil {
		owners = []string{}
	}
	if r := f.m.Handle(Request{Op: "sync", Owners: owners}); !r.OK {
		t.Fatal(r)
	}
}
func (f *fixture) open(t *testing.T, owner int) (Request, Reply) {
	t.Helper()
	f.nextID++
	list := f.m.Handle(Request{Op: "list", Owner: f.owners[owner]})
	r := Request{Op: "open", Owner: f.owners[owner], Instance: list.Instance, ID: fmt.Sprintf("%032x", f.nextID), Shell: "zsh", Columns: 100, Rows: 30, Sequence: list.NextOpen}
	return r, f.m.Handle(r)
}
func command(open Request, op string) Request {
	return Request{Op: op, Owner: open.Owner, Instance: open.Instance, ID: open.ID}
}
func input(open Request, sequence int64, text string) Request {
	r := command(open, "write")
	r.Sequence = sequence
	r.Data = base64.StdEncoding.EncodeToString([]byte(text))
	return r
}
func check(t *testing.T, r Reply, code string) {
	t.Helper()
	if code == "" {
		if !r.OK {
			t.Fatal(r)
		}
	} else if r.OK || r.Code != code {
		t.Fatalf("want %s got %+v", code, r)
	}
}

func TestOwnerIsolationAndShellInventory(t *testing.T) {
	f := setup(t)
	open, reply := f.open(t, 0)
	check(t, reply, "")
	list := f.m.Handle(Request{Op: "list", Owner: f.owners[0]})
	if strings.Join(list.Shells, ",") != "zsh,bash" || list.PasteLimit != PasteLimit || len(list.Sessions) != 1 {
		t.Fatal(list)
	}
	other := f.m.Handle(Request{Op: "list", Owner: f.owners[1]})
	if len(other.Sessions) != 0 || other.NextOpen != 1 {
		t.Fatal(other)
	}
	r := command(open, "read")
	r.Owner = f.owners[1]
	check(t, f.m.Handle(r), "TERMINAL_NOT_FOUND")
	r.Owner = strings.Repeat("d", 64)
	check(t, f.m.Handle(r), "TERMINAL_UNPAIRED")
	r = command(open, "close")
	r.Instance = strings.Repeat("e", 32)
	check(t, f.m.Handle(r), "TERMINAL_STALE")
	if f.processes[0].closing {
		t.Fatal("another owner changed session")
	}
}
func TestOpenLostReplyAndFailureNeverCreateSecondShell(t *testing.T) {
	f := setup(t)
	open, reply := f.open(t, 0)
	check(t, reply, "")
	check(t, f.m.Handle(open), "")
	if len(f.processes) != 1 {
		t.Fatal("open replay")
	}
	changed := open
	changed.Shell = "bash"
	check(t, f.m.Handle(changed), "TERMINAL_ID_CONFLICT")
	changed = open
	changed.ID = strings.Repeat("f", 32)
	check(t, f.m.Handle(changed), "TERMINAL_SEQUENCE")
	check(t, f.m.Handle(command(open, "close")), "")
	f.clock = RetentionMs
	f.sync(t, f.owners...)
	check(t, f.m.Handle(open), "TERMINAL_SEQUENCE")
	f.fail = true
	failed, reply := f.open(t, 0)
	check(t, reply, "TERMINAL_UNAVAILABLE")
	again := f.m.Handle(failed)
	check(t, again, "")
	if again.Session.State != "failed" || len(f.processes) != 2 || !f.processes[1].closing {
		t.Fatal(again)
	}
}
func TestInputAcknowledgmentsAndOperationBoundDeduplication(t *testing.T) {
	f := setup(t)
	open, _ := f.open(t, 0)
	r := input(open, 1, "中文 👋\r")
	first := f.m.Handle(r)
	check(t, first, "")
	if first.Session.AcceptedSequence != 1 || first.Session.WrittenSequence != 0 {
		t.Fatal(first)
	}
	check(t, f.m.Handle(r), "")
	if len(f.processes[0].writes) != 1 {
		t.Fatal("input replayed")
	}
	changed := r
	changed.Data = base64.StdEncoding.EncodeToString([]byte("different"))
	check(t, f.m.Handle(changed), "TERMINAL_INPUT_CONFLICT")
	changed = r
	changed.Op = "paste"
	check(t, f.m.Handle(changed), "TERMINAL_INPUT_CONFLICT")
	check(t, f.m.Handle(input(open, 3, "future")), "TERMINAL_SEQUENCE")
	f.processes[0].state.Written = 1
	read := f.m.Handle(command(open, "read"))
	if read.Session.WrittenSequence != 1 {
		t.Fatal(read)
	}
	f.processes[0].busy = true
	check(t, f.m.Handle(input(open, 2, "busy")), "TERMINAL_BUSY")
	f.processes[0].busy = false
	check(t, f.m.Handle(input(open, 2, "accepted after busy")), "")
}
func TestInputBoundsAndWholePaste(t *testing.T) {
	f := setup(t)
	open, _ := f.open(t, 0)
	for _, size := range []int{0, 4097} {
		check(t, f.m.Handle(input(open, 1, strings.Repeat("x", size))), "TERMINAL_BAD_REQUEST")
	}
	r := input(open, 1, strings.Repeat("x", PasteLimit))
	r.Op = "paste"
	check(t, f.m.Handle(r), "")
	check(t, f.m.Handle(r), "")
	if len(f.processes[0].writes) != 1 || len(f.processes[0].writes[0]) != PasteLimit {
		t.Fatal("paste split or replayed")
	}
	r = input(open, 2, "x")
	r.Data = "eA"
	check(t, f.m.Handle(r), "TERMINAL_BAD_REQUEST")
	r = input(open, 2, strings.Repeat("x", PasteLimit+1))
	r.Op = "paste"
	check(t, f.m.Handle(r), "TERMINAL_BAD_REQUEST")
}
func TestOutputRingGapAndResume(t *testing.T) {
	f := setup(t)
	open, _ := f.open(t, 0)
	data := bytes.Repeat([]byte("0123456789"), OutputLimit/10+200)
	f.processes[0].output(data)
	read := f.m.Handle(command(open, "read"))
	check(t, read, "")
	first := int64(len(data) - OutputLimit)
	decoded, err := base64.StdEncoding.DecodeString(read.Data)
	if err != nil || !read.Gap || read.Offset != first || read.Next != first+ReadLimit || !bytes.Equal(decoded, data[first:first+ReadLimit]) {
		t.Fatal(read.Offset, read.Next, read.Gap, err)
	}
	r := command(open, "read")
	r.Offset = read.Next
	next := f.m.Handle(r)
	if next.Gap || next.Offset != r.Offset {
		t.Fatal(next)
	}
	r.Offset = int64(len(data)) + 1
	check(t, f.m.Handle(r), "TERMINAL_OFFSET")
}
func TestRevocationAuthorizationLeaseAndIdleExpiry(t *testing.T) {
	t.Run("owner-revocation", func(t *testing.T) {
		f := setup(t)
		_, _ = f.open(t, 0)
		other, _ := f.open(t, 1)
		f.sync(t, f.owners[1])
		if !f.processes[0].closing || f.processes[1].closing {
			t.Fatal("revocation crossed owner")
		}
		check(t, f.m.Handle(command(other, "read")), "")
	})
	t.Run("independent-authorization-expiry", func(t *testing.T) {
		f := setup(t)
		_, _ = f.open(t, 0)
		f.clock = AuthorizationMs
		f.m.Maintain()
		if !f.processes[0].closing {
			t.Fatal("permission lease did not stop process")
		}
	})
	t.Run("idle-expiry", func(t *testing.T) {
		f := setup(t)
		open, _ := f.open(t, 0)
		f.clock = IdleMs
		f.sync(t, f.owners...)
		reply := f.m.Handle(command(open, "read"))
		if reply.Session.State != "expired" || !f.processes[0].closing {
			t.Fatal(reply)
		}
	})
}
func TestCapacityIncludesChildrenStillClosing(t *testing.T) {
	f := setup(t)
	var opens []Request
	for i := 0; i < 4; i++ {
		open, reply := f.open(t, 0)
		check(t, reply, "")
		opens = append(opens, open)
		f.processes[i].delayClose = true
	}
	_, reply := f.open(t, 0)
	check(t, reply, "TERMINAL_CAPACITY")
	for _, open := range opens {
		check(t, f.m.Handle(command(open, "close")), "")
	}
	_, reply = f.open(t, 0)
	check(t, reply, "TERMINAL_CAPACITY")
	for i := 0; i < 4; i++ {
		_, reply = f.open(t, 1)
		check(t, reply, "")
	}
	_, reply = f.open(t, 2)
	check(t, reply, "TERMINAL_CAPACITY")
	for i := 0; i < 4; i++ {
		close(f.processes[i].done)
	}
	_, reply = f.open(t, 0)
	check(t, reply, "")
}
func TestExitFailureResizeAndIdempotentClose(t *testing.T) {
	f := setup(t)
	open, _ := f.open(t, 0)
	r := command(open, "resize")
	r.Columns = 120
	r.Rows = 40
	reply := f.m.Handle(r)
	check(t, reply, "")
	if reply.Session.Columns != 120 || reply.Session.Rows != 40 {
		t.Fatal(reply)
	}
	f.processes[0].state.Exited = true
	f.processes[0].state.ExitCode = 7
	f.m.Maintain()
	reply = f.m.Handle(command(open, "read"))
	if reply.Session.State != "exited" || reply.Session.ExitCode != 7 {
		t.Fatal(reply)
	}
	check(t, f.m.Handle(input(open, 1, "closed")), "TERMINAL_CLOSED")
	_, _ = f.open(t, 1)
	f.processes[1].state.Failed = true
	f.m.Maintain()
	if !f.processes[1].closing {
		t.Fatal("failed process not stopped")
	}
	f.m.Close()
	f.m.Close()
	check(t, f.m.Handle(Request{Op: "list", Owner: f.owners[0]}), "TERMINAL_UNAVAILABLE")
}
func TestStrictOwnedProtocol(t *testing.T) {
	owner := strings.Repeat("a", 64)
	instance := strings.Repeat("b", 32)
	id := strings.Repeat("c", 32)
	valid := []string{`{"op":"sync","owners":[]}`, `{"op":"list","owner":"` + owner + `"}`, `{"op":"read","owner":"` + owner + `","instance":"` + instance + `","id":"` + id + `","offset":0}`}
	for _, raw := range valid {
		if _, err := Decode([]byte(raw)); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{`{"op":"list","op":"sync","owners":[]}`, `{"Op":"sync","owners":[]}`, `{"op":"sync","owners":null}`, `{"op":"sync","owners":[],"command":"sh"}`, valid[0] + `{}`, `{"op":"read","owner":"` + owner + `","instance":"` + instance + `","id":"` + id + `","offset":0.0}`, strings.Repeat(" ", RequestLimit+1)} {
		if _, err := Decode([]byte(raw)); err == nil {
			t.Fatal("invalid frame accepted", raw)
		}
	}
	f := setup(t)
	_, reply := f.open(t, 0)
	raw, err := json.Marshal(reply)
	if err != nil || len(raw) > ReplyLimit {
		t.Fatal(err, len(raw))
	}
}
