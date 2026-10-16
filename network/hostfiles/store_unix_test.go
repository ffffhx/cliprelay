//go:build darwin || linux

package hostfiles

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const firstOwner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const secondOwner = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func transferID(number int) string { return fmt.Sprintf("%032x", number) }
func number(value int64) *int64    { return &value }

type storeFixture struct {
	store         *Store
	options       Options
	root, private string
}

func newStoreFixture(t *testing.T) *storeFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &storeFixture{root: filepath.Join(base, "home")}
	f.private = filepath.Join(f.root, "application-data")
	state := filepath.Join(f.private, "transfers")
	for _, dir := range []string{f.root, f.private, state} {
		if err = os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.options = Options{Roots: map[string]string{"home": f.root}, StateDirectory: state, ExcludedDirectories: []string{f.private}}
	f.store, err = Open(context.Background(), f.options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	return f
}
func (f *storeFixture) reopen(t *testing.T) {
	t.Helper()
	f.store.Close()
	var err error
	f.store, err = Open(context.Background(), f.options)
	if err != nil {
		t.Fatal(err)
	}
}
func (f *storeFixture) call(t *testing.T, q Request) Response {
	t.Helper()
	if q.Owner == "" {
		q.Owner = firstOwner
	}
	value := f.store.Handle(q)
	if !value.OK {
		t.Fatalf("%s: %s", q.Op, value.Code)
	}
	return value
}
func (f *storeFixture) wait(t *testing.T, id, state string) Response {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		value := f.call(t, Request{Op: "status", ID: id})
		if value.State == state {
			return value
		}
		if value.State == "error" {
			t.Fatalf("transfer failed: %s", value.Code)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("transfer did not reach " + state)
	return Response{}
}
func (f *storeFixture) start(t *testing.T, id, name string, data []byte) Response {
	t.Helper()
	return f.call(t, Request{Op: "upload-start", ID: id, Root: "home", Name: name, Size: number(int64(len(data))), SHA256: digest(data)})
}
func (f *storeFixture) chunk(t *testing.T, id string, offset int64, data []byte) Response {
	t.Helper()
	return f.call(t, Request{Op: "upload-chunk", ID: id, Offset: number(offset), Data: base64.StdEncoding.EncodeToString(data), SHA256: digest(data)})
}
func (f *storeFixture) send(t *testing.T, id, name string, data []byte) Response {
	t.Helper()
	f.start(t, id, name, data)
	for offset := 0; offset < len(data); offset += ChunkSize {
		f.chunk(t, id, int64(offset), data[offset:min(len(data), offset+ChunkSize)])
	}
	f.call(t, Request{Op: "finish", ID: id})
	return f.wait(t, id, "complete")
}

func TestUploadResumeLostAcknowledgmentAndNoOverwrite(t *testing.T) {
	f := newStoreFixture(t)
	id := transferID(1)
	data := bytes.Repeat([]byte("resume/\x00中文"), 70000)
	original := []byte("existing destination")
	if err := os.WriteFile(filepath.Join(f.root, "sample.bin"), original, 0600); err != nil {
		t.Fatal(err)
	}
	f.start(t, id, "sample.bin", data)
	first := data[:ChunkSize]
	f.chunk(t, id, 0, first)
	if retry := f.chunk(t, id, 0, first); retry.Offset != ChunkSize {
		t.Fatal("lost receipt retry advanced offset")
	}
	changed := append([]byte(nil), first...)
	changed[0] ^= 1
	bad := f.store.Handle(Request{Owner: firstOwner, Op: "upload-chunk", ID: id, Offset: number(0), Data: base64.StdEncoding.EncodeToString(changed), SHA256: digest(changed)})
	if bad.Code != "FILES_CHUNK_CONFLICT" {
		t.Fatal("conflicting retry", bad)
	}
	r := f.store.records[firstOwner+"-"+id]
	part := filepath.Join(f.root, ".cliprelay-transfers", partName(r))
	file, err := os.OpenFile(part, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.Write(bytes.Repeat([]byte{99}, 79))
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	f.reopen(t)
	resumed := f.start(t, id, "sample.bin", data)
	if resumed.Offset != ChunkSize {
		t.Fatal("crash tail acknowledged", resumed)
	}
	for offset := ChunkSize; offset < len(data); offset += ChunkSize {
		f.chunk(t, id, int64(offset), data[offset:min(len(data), offset+ChunkSize)])
	}
	f.call(t, Request{Op: "finish", ID: id})
	completed := f.wait(t, id, "complete")
	if completed.FinalName != "sample (1).bin" || completed.Verified != int64(len(data)) {
		t.Fatal(completed)
	}
	actual, err := os.ReadFile(filepath.Join(f.root, completed.FinalName))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("uploaded bytes differ", err)
	}
	actual, _ = os.ReadFile(filepath.Join(f.root, "sample.bin"))
	if !bytes.Equal(actual, original) {
		t.Fatal("destination overwritten")
	}
	if _, err = os.Stat(part); !os.IsNotExist(err) {
		t.Fatal("committed part retained", err)
	}
	f.reopen(t)
	if done := f.call(t, Request{Op: "finish", ID: id}); done.FinalName != completed.FinalName || done.State != "complete" {
		t.Fatal("lost final receipt did not remain complete")
	}
}

func TestCertificateOwnershipAndIDConflict(t *testing.T) {
	f := newStoreFixture(t)
	id := transferID(2)
	data := []byte("one certificate")
	f.start(t, id, "owner.bin", data)
	if value := f.store.Handle(Request{Owner: secondOwner, Op: "status", ID: id}); value.Code != "FILES_NOT_FOUND" {
		t.Fatal("foreign journal exposed", value)
	}
	if value := f.store.Handle(Request{Owner: secondOwner, Op: "cancel", ID: id}); value.Code != "FILES_NOT_FOUND" {
		t.Fatal("foreign transfer canceled", value)
	}
	value := f.store.Handle(Request{Owner: firstOwner, Op: "upload-start", ID: id, Root: "home", Name: "other.bin", Size: number(int64(len(data))), SHA256: digest(data)})
	if value.Code != "FILES_ID_CONFLICT" {
		t.Fatal("ID was retargeted", value)
	}
	second := f.call(t, Request{Owner: secondOwner, Op: "upload-start", ID: id, Root: "home", Name: "other.bin", Size: number(0), SHA256: digest(nil)})
	if second.Offset != 0 || second.Name != "other.bin" {
		t.Fatal("certificate namespaces merged")
	}
	f.call(t, Request{Owner: secondOwner, Op: "cancel", ID: id})
	if f.call(t, Request{Op: "status", ID: id}).State != "uploading" {
		t.Fatal("other certificate cancellation affected owner")
	}
}

func TestDownloadHashChunksAndSourceReplacement(t *testing.T) {
	f := newStoreFixture(t)
	id := transferID(3)
	data := bytes.Repeat([]byte("download\x00"), 60000)
	source := filepath.Join(f.root, "download.bin")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	f.call(t, Request{Op: "download-start", ID: id, Root: "home", Name: "download.bin"})
	ready := f.wait(t, id, "ready")
	if ready.SHA256 != digest(data) || ready.Size != int64(len(data)) {
		t.Fatal(ready)
	}
	var received []byte
	for offset := int64(0); offset < int64(len(data)); offset += ChunkSize {
		chunk := f.call(t, Request{Op: "download-chunk", ID: id, Offset: number(offset)})
		decoded, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil || digest(decoded) != chunk.SHA256 {
			t.Fatal("bad chunk")
		}
		received = append(received, decoded...)
	}
	if !bytes.Equal(received, data) {
		t.Fatal("download mismatch")
	}
	eof := f.call(t, Request{Op: "download-chunk", ID: id, Offset: number(int64(len(data)))})
	if eof.Data != "" || eof.SHA256 != digest(nil) {
		t.Fatal("EOF mismatch")
	}
	f.call(t, Request{Op: "finish", ID: id, SHA256: digest(data)})
	f.reopen(t)
	if f.call(t, Request{Op: "status", ID: id}).State != "complete" {
		t.Fatal("download receipt lost")
	}
	if err := os.Rename(source, source+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	if value := f.store.Handle(Request{Owner: firstOwner, Op: "download-chunk", ID: id, Offset: number(0)}); value.Code != "FILES_SOURCE_CHANGED" {
		t.Fatal("replacement source adopted", value)
	}
}

func TestPathLinksDevicesAndPrivateMetadata(t *testing.T) {
	f := newStoreFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(f.root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(f.root, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../", "/tmp", "a/../b", "a//b", "escape", "application-data", ".cliprelay-transfers", "a\\b"} {
		if value := f.store.Handle(Request{Owner: firstOwner, Op: "list", Root: "home", Path: path}); value.OK {
			t.Fatal("unsafe directory admitted", path)
		}
	}
	for index, name := range []string{"linked", "pipe", "../secret"} {
		if value := f.store.Handle(Request{Owner: firstOwner, Op: "download-start", ID: transferID(10 + index), Root: "home", Name: name}); value.OK {
			t.Fatal("unsafe source admitted", name)
		}
	}
	f.start(t, transferID(19), "part.bin", []byte("partial"))
	listed := f.call(t, Request{Op: "list", Root: "home"})
	seen := map[string]Entry{}
	for _, entry := range listed.Entries {
		seen[entry.Name] = entry
		if entry.Name == "application-data" || strings.HasPrefix(entry.Name, ".cliprelay-") {
			t.Fatal("private metadata listed", entry)
		}
	}
	if !seen["escape"].Blocked || !seen["linked"].Blocked || !seen["pipe"].Blocked {
		t.Fatal("unsafe entries not marked")
	}
	// Exclusion survives renaming the private directory while the store owns it.
	renamed := filepath.Join(f.root, "renamed-private")
	if err := os.Rename(f.private, renamed); err != nil {
		t.Fatal(err)
	}
	if value := f.store.Handle(Request{Owner: firstOwner, Op: "list", Root: "home", Path: "renamed-private"}); value.OK {
		t.Fatal("renamed private directory exposed")
	}
}

func TestDirectoryReplacementCannotRetargetResume(t *testing.T) {
	f := newStoreFixture(t)
	folder := filepath.Join(f.root, "destination")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	id := transferID(20)
	data := []byte("destination binding")
	f.call(t, Request{Op: "upload-start", ID: id, Root: "home", Path: "destination", Name: "file.bin", Size: number(int64(len(data))), SHA256: digest(data)})
	if err := os.Rename(folder, folder+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	value := f.store.Handle(Request{Owner: firstOwner, Op: "upload-chunk", ID: id, Offset: number(0), Data: base64.StdEncoding.EncodeToString(data), SHA256: digest(data)})
	if value.Code != "FILES_SOURCE_CHANGED" {
		t.Fatal("replaced destination adopted", value)
	}
}

func TestCommitCrashRecoveryRequiresOriginalInode(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(fmt.Sprint(replace), func(t *testing.T) {
			f := newStoreFixture(t)
			id := transferID(30)
			data := []byte("durable committed bytes")
			f.start(t, id, "commit.bin", data)
			f.chunk(t, id, 0, data)
			r := f.store.records[firstOwner+"-"+id]
			next := *r
			next.State = "committing"
			next.FinalName = "commit.bin"
			if err := f.store.save(r, next); err != nil {
				t.Fatal(err)
			}
			stage, err := f.store.stage("home")
			if err != nil {
				t.Fatal(err)
			}
			d, err := f.store.recordFolder(r)
			if err != nil {
				t.Fatal(err)
			}
			if err = renameExclusive(stage, partName(r), d, r.FinalName); err != nil {
				t.Fatal(err)
			}
			d.sync()
			stage.sync()
			d.close()
			f.reopen(t)
			if replace {
				path := filepath.Join(f.root, "commit.bin")
				if err = os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
				if value := f.store.Handle(Request{Owner: firstOwner, Op: "status", ID: id}); value.Code != "FILES_INVALID_STATE" {
					t.Fatal("same-content replacement adopted", value)
				}
			} else {
				value := f.wait(t, id, "complete")
				if value.FinalName != "commit.bin" {
					t.Fatal(value)
				}
			}
		})
	}
}

func TestCancelBeforeHashPublicationAndJoinedClose(t *testing.T) {
	f := newStoreFixture(t)
	id := transferID(40)
	data := bytes.Repeat([]byte{7}, ChunkSize)
	f.start(t, id, "cancel.bin", data)
	f.chunk(t, id, 0, data)
	// Serialize cancellation before the worker can publish progress. Both use
	// the production handler transition; the real hash goroutine is joined.
	f.store.mu.Lock()
	r := f.store.records[firstOwner+"-"+id]
	if err := f.store.beginHash(r); err != nil {
		f.store.mu.Unlock()
		t.Fatal(err)
	}
	value, err := f.store.handle(Request{Owner: firstOwner, Op: "cancel", ID: id})
	f.store.mu.Unlock()
	if err != nil || value.State != "cancelled" {
		t.Fatal(value, err)
	}
	f.store.Close()
	if _, err = os.Stat(filepath.Join(f.root, "cancel.bin")); !os.IsNotExist(err) {
		t.Fatal("canceled hash published file")
	}
	f.reopen(t)
	if f.call(t, Request{Op: "status", ID: id}).State != "cancelled" {
		t.Fatal("cancel state lost")
	}
	if files, err := os.ReadDir(filepath.Join(f.root, ".cliprelay-transfers")); err != nil || len(files) != 0 {
		t.Fatal("cancelled part retained", err)
	}
}

func TestExclusiveJournalOwnerAndBoundedQueue(t *testing.T) {
	f := newStoreFixture(t)
	if other, err := Open(context.Background(), f.options); err == nil {
		other.Close()
		t.Fatal("two workers acquired journal store")
	}
	for i := 0; i < 256; i++ {
		f.start(t, transferID(100+i), fmt.Sprintf("%d.bin", i), nil)
	}
	value := f.store.Handle(Request{Owner: secondOwner, Op: "upload-start", ID: transferID(999), Root: "home", Name: "overflow.bin", Size: number(0), SHA256: digest(nil)})
	if value.Code != "FILES_QUEUE_FULL" {
		t.Fatal("unbounded metadata", value)
	}
}

func TestConcurrentDirectorySymlinkSubstitutionCannotEscape(t *testing.T) {
	f := newStoreFixture(t)
	outside := t.TempDir()
	inside := filepath.Join(f.root, "real")
	visible := filepath.Join(f.root, "swap")
	if err := os.Mkdir(inside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "value"), []byte("inside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "value"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var joined sync.WaitGroup
	joined.Add(1)
	go func() {
		defer joined.Done()
		for ctx.Err() == nil {
			if os.Rename(inside, visible) == nil {
				_ = os.Rename(visible, inside)
			}
			if os.Symlink(outside, visible) == nil {
				_ = os.Remove(visible)
			}
		}
	}()
	defer func() { cancel(); joined.Wait() }()
	for i := 0; i < 500; i++ {
		d, err := f.store.folder("home", "swap")
		if err != nil {
			continue
		}
		file, _, err := d.regular("value", unix.O_RDONLY, false)
		d.close()
		if err != nil {
			continue
		}
		value, err := io.ReadAll(file)
		file.Close()
		if err != nil || string(value) != "inside" {
			t.Fatal("symlink substitution escaped root", string(value), err)
		}
	}
}

func TestHashFailureDoesNotPublishAndEmptyFilesComplete(t *testing.T) {
	f := newStoreFixture(t)
	id := transferID(50)
	data := []byte("corrupt body")
	f.call(t, Request{Op: "upload-start", ID: id, Root: "home", Name: "bad.bin", Size: number(int64(len(data))), SHA256: digest([]byte("expected"))})
	f.chunk(t, id, 0, data)
	f.call(t, Request{Op: "finish", ID: id})
	deadline := time.Now().Add(10 * time.Second)
	var value Response
	for time.Now().Before(deadline) {
		value = f.call(t, Request{Op: "status", ID: id})
		if value.State == "error" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if value.State != "error" || value.Code != "FILES_HASH_MISMATCH" {
		t.Fatal(value)
	}
	if _, err := os.Stat(filepath.Join(f.root, "bad.bin")); !os.IsNotExist(err) {
		t.Fatal("corrupt transfer published")
	}
	f.call(t, Request{Op: "cancel", ID: id})
	for i := 0; i < 2; i++ {
		value := f.send(t, transferID(51+i), "empty.bin", nil)
		if value.Offset != 0 || value.Verified != 0 || value.SHA256 != digest(nil) {
			t.Fatal(value)
		}
	}
	if data, err := os.ReadFile(filepath.Join(f.root, "empty (1).bin")); err != nil || len(data) != 0 {
		t.Fatal("empty collision failed", err)
	}
}

func TestDirectoryPaginationAndMkdirNeverReplace(t *testing.T) {
	f := newStoreFixture(t)
	f.call(t, Request{Op: "mkdir", Root: "home", Name: "folder"})
	if value := f.store.Handle(Request{Owner: firstOwner, Op: "mkdir", Root: "home", Name: "folder"}); value.Code != "FILES_EXISTS" {
		t.Fatal("existing directory replaced", value)
	}
	for i := 0; i < 270; i++ {
		if err := os.WriteFile(filepath.Join(f.root, fmt.Sprintf("file-%03d.bin", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	first := f.call(t, Request{Op: "list", Root: "home"})
	second := f.call(t, Request{Op: "list", Root: "home", After: first.Next})
	if len(first.Entries) != 256 || first.Next == "" || len(second.Entries) != 15 || second.Next != "" {
		t.Fatal("pagination bounds", len(first.Entries), len(second.Entries))
	}
	seen := map[string]bool{}
	for _, entry := range append(first.Entries, second.Entries...) {
		if seen[entry.Name] {
			t.Fatal("pagination duplicated entry")
		}
		seen[entry.Name] = true
	}
	if !first.Entries[0].Directory || first.Entries[0].Name != "folder" {
		t.Fatal("directories not ordered first")
	}
}

func TestCaseSensitiveFilesystemNamesRemainDistinct(t *testing.T) {
	f := newStoreFixture(t)
	first, err := os.OpenFile(filepath.Join(f.root, "Case.bin"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := os.OpenFile(filepath.Join(f.root, "case.bin"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		t.Skip("fixture volume is case-insensitive")
	}
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
	value := f.call(t, Request{Op: "list", Root: "home"})
	if len(value.Entries) != 2 || value.Entries[0].Name == value.Entries[1].Name || value.Entries[0].Blocked || value.Entries[1].Blocked {
		t.Fatal("distinct names lost", value)
	}
}

func TestConcurrentCommitsAndExistingDirectoryAreNotOverwritten(t *testing.T) {
	f := newStoreFixture(t)
	if err := os.Mkdir(filepath.Join(f.root, "same.bin"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		id := transferID(500 + i)
		data := bytes.Repeat([]byte{byte(i)}, ChunkSize)
		f.start(t, id, "same.bin", data)
		f.chunk(t, id, 0, data)
		f.call(t, Request{Op: "finish", ID: id})
	}
	seen := map[string]bool{}
	for i := 0; i < 6; i++ {
		value := f.wait(t, transferID(500+i), "complete")
		if seen[value.FinalName] {
			t.Fatal("commits shared destination")
		}
		seen[value.FinalName] = true
		data, err := os.ReadFile(filepath.Join(f.root, value.FinalName))
		if err != nil || !bytes.Equal(data, bytes.Repeat([]byte{byte(i)}, ChunkSize)) {
			t.Fatal("concurrent commit lost bytes", err)
		}
	}
	if st, err := os.Stat(filepath.Join(f.root, "same.bin")); err != nil || !st.IsDir() {
		t.Fatal("existing directory replaced", err)
	}
}
