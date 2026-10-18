//go:build darwin || linux

package hostfiles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type Options struct {
	// Options are local configuration. No network request can change roots or
	// the journal directory. Existing directories are opened once and anchored.
	Roots               map[string]string
	StateDirectory      string
	ExcludedDirectories []string
}
type Store struct {
	mu      sync.Mutex
	roots   map[string]*directory
	stages  map[string]*directory
	blocked map[fileKey]bool
	state   *directory
	lock    *os.File
	records map[string]*record
	jobs    map[string]context.CancelFunc
	ctx     context.Context
	cancel  context.CancelFunc
	workers sync.WaitGroup
	closed  bool
}

func Open(parent context.Context, options Options) (*Store, error) {
	if len(options.Roots) == 0 || len(options.Roots) > 16 {
		return nil, fail("UNAVAILABLE")
	}
	s := &Store{roots: map[string]*directory{}, stages: map[string]*directory{}, blocked: map[fileKey]bool{}, records: map[string]*record{}, jobs: map[string]context.CancelFunc{}}
	s.ctx, s.cancel = context.WithCancel(parent)
	good := false
	defer func() {
		if !good {
			s.Close()
		}
	}()
	var err error
	s.state, err = openDirectory(options.StateDirectory)
	if err != nil {
		return nil, err
	}
	if err = s.state.private(); err != nil {
		return nil, err
	}
	s.blocked[s.state.key] = true
	s.lock, _, err = s.state.regular(".lock", unix.O_RDWR|unix.O_CREAT, true)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(s.lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, fail("UNAVAILABLE")
	}
	for _, path := range options.ExcludedDirectories {
		d, err := openDirectory(path)
		if err != nil {
			return nil, err
		}
		s.blocked[d.key] = true
		d.close()
	}
	for id, path := range options.Roots {
		if !rootPattern.MatchString(id) {
			return nil, fail("BAD_PATH")
		}
		d, err := openDirectory(path)
		if err != nil {
			return nil, err
		}
		if s.blocked[d.key] {
			d.close()
			return nil, fail("BAD_PATH")
		}
		s.roots[id] = d
		// Preserve the exclusion by inode as well as by reserved name when an
		// existing staging directory is encountered through a different root.
		stage, err := d.child(".cliprelay-transfers")
		if err == nil {
			if err = stage.private(); err != nil || stage.key.Device != d.key.Device {
				stage.close()
				return nil, fail("ACCESS_DENIED")
			}
			s.stages[id] = stage
			s.blocked[stage.key] = true
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	good = true
	return s, nil
}
func (s *Store) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.workers.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, d := range s.stages {
		d.close()
		delete(s.stages, id)
	}
	for id, d := range s.roots {
		d.close()
		delete(s.roots, id)
	}
	if s.lock != nil {
		s.lock.Close()
		s.lock = nil
	}
	if s.state != nil {
		s.state.close()
		s.state = nil
	}
}
func (s *Store) folder(root, path string) (*directory, error) {
	d := s.roots[root]
	if d == nil {
		return nil, fail("BAD_PATH")
	}
	return d.walk(path, s.blocked)
}
func (s *Store) recordFolder(r *record) (*directory, error) {
	d, err := s.folder(r.Root, r.Directory)
	if err != nil {
		return nil, err
	}
	if d.key != r.Folder {
		d.close()
		return nil, fail("SOURCE_CHANGED")
	}
	return d, nil
}
func (s *Store) stage(root string) (*directory, error) {
	if d := s.stages[root]; d != nil {
		return d, nil
	}
	r := s.roots[root]
	if r == nil {
		return nil, fail("BAD_PATH")
	}
	d, err := r.privateChild(".cliprelay-transfers")
	if err != nil {
		return nil, err
	}
	if d.key.Device != r.key.Device {
		d.close()
		return nil, fail("BAD_PATH")
	}
	s.stages[root] = d
	s.blocked[d.key] = true
	return d, nil
}
func partName(r *record) string { return ".cliprelay-" + r.key() + ".part" }
func (s *Store) part(r *record, flags int) (*os.File, error) {
	d, err := s.stage(r.Root)
	if err != nil {
		return nil, err
	}
	f, st, err := d.regular(partName(r), flags, true)
	if err != nil {
		return nil, err
	}
	if identity(&st) != r.Part {
		f.Close()
		return nil, fail("INVALID_STATE")
	}
	return f, nil
}
func (s *Store) deletePart(r *record) error {
	d, err := s.stage(r.Root)
	if err != nil {
		return err
	}
	if err = d.unlink(partName(r), r.Part); err != nil {
		return err
	}
	return d.sync()
}

// The payload is flushed before the journal's atomic replacement. A failed
// update invalidates the in-memory record so a later request reads actual disk
// state rather than guessing whether a rename already happened.
func (s *Store) save(r *record, next record) (err error) {
	next.Updated = time.Now().UnixMilli()
	raw, err := json.Marshal(next)
	if err != nil || len(raw) > 16384 {
		return fail("INVALID_STATE")
	}
	name, err := token()
	if err != nil {
		return err
	}
	name = ".journal-" + name + ".tmp"
	f, st, err := s.state.regular(name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL, true)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		_ = s.state.unlink(name, identity(&st))
		if err != nil {
			delete(s.records, next.key())
		}
	}()
	if n, writeErr := f.Write(raw); writeErr != nil {
		return writeErr
	} else if n != len(raw) {
		return io.ErrShortWrite
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = unix.Renameat(s.state.fd(), name, s.state.fd(), next.key()+".json"); err != nil {
		return err
	}
	if err = s.state.sync(); err != nil {
		return err
	}
	*r = next
	s.records[r.key()] = r
	return nil
}
func (s *Store) load(owner, id string) (*record, error) {
	key := owner + "-" + id
	if r := s.records[key]; r != nil {
		return r, nil
	}
	f, _, err := s.state.regular(key+".json", unix.O_RDONLY, true)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil {
		return nil, err
	}
	if len(raw) > 16384 {
		return nil, fail("INVALID_STATE")
	}
	var r record
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&r) != nil || decoder.Decode(new(any)) != io.EOF || r.Owner != owner || r.ID != id ||
		!rootPattern.MatchString(r.Root) || !safePath(r.Directory) || !safeName(r.Name) ||
		(r.Direction != "upload" && r.Direction != "download") || r.Size < 0 || r.Size > MaxFileSize || r.Offset < 0 || r.Offset > r.Size ||
		r.Verified < 0 || r.Verified > r.Size || (r.SHA256 != "" && !ownerPattern.MatchString(r.SHA256)) ||
		(r.FinalName != "" && !safeName(r.FinalName)) || r.Folder == (fileKey{}) {
		return nil, fail("INVALID_STATE")
	}
	switch r.State {
	case "uploading", "preparing", "queued", "verifying", "committing", "ready", "complete", "cancelled", "error":
	default:
		return nil, fail("INVALID_STATE")
	}
	if r.Direction == "upload" && (!ownerPattern.MatchString(r.SHA256) || r.Part == (fileKey{})) ||
		r.Direction == "download" && (r.Source.Key == (fileKey{}) || r.Source.Size != r.Size) {
		return nil, fail("INVALID_STATE")
	}
	if r.State == "committing" && (r.Direction != "upload" || r.FinalName == "") {
		return nil, fail("INVALID_STATE")
	}
	if r.State == "verifying" {
		r.State = "queued"
		r.Verified = 0
	}
	s.records[key] = &r
	return &r, nil
}
func (s *Store) Handle(request Request) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.handle(request)
	if err != nil {
		return Response{Code: errorCode(err)}
	}
	return value
}
func (s *Store) handle(q Request) (Response, error) {
	if s.closed || s.ctx.Err() != nil {
		return Response{}, fail("UNAVAILABLE")
	}
	if !ownerPattern.MatchString(q.Owner) || len(q.After) > 1024 || len(q.Data) > ((ChunkSize+2)/3)*4 ||
		(q.Size != nil && (*q.Size < 0 || *q.Size > MaxFileSize)) || (q.Offset != nil && (*q.Offset < 0 || *q.Offset > MaxFileSize)) {
		return Response{}, fail("BAD_REQUEST")
	}
	if q.Op != "upload-chunk" && q.Data != "" {
		return Response{}, fail("BAD_REQUEST")
	}
	switch q.Op {
	case "roots":
		value := Response{OK: true, ChunkSize: ChunkSize, Roots: []Root{}}
		for id, d := range s.roots {
			value.Roots = append(value.Roots, Root{id, id, unix.Faccessat(d.fd(), ".", unix.W_OK, 0) == nil})
		}
		sort.Slice(value.Roots, func(i, j int) bool { return value.Roots[i].ID < value.Roots[j].ID })
		return value, nil
	case "list":
		return s.list(q)
	case "mkdir":
		if !safeName(q.Name) {
			return Response{}, fail("BAD_PATH")
		}
		d, err := s.folder(q.Root, q.Path)
		if err != nil {
			return Response{}, err
		}
		defer d.close()
		if err = unix.Mkdirat(d.fd(), q.Name, 0700); err != nil {
			return Response{}, err
		}
		if err = d.sync(); err != nil {
			return Response{}, err
		}
		return Response{OK: true}, nil
	}
	if !idPattern.MatchString(q.ID) {
		return Response{}, fail("BAD_REQUEST")
	}
	if q.Op == "upload-start" || q.Op == "download-start" {
		return s.start(q)
	}
	r, err := s.load(q.Owner, q.ID)
	if err != nil {
		return Response{}, err
	}
	switch q.Op {
	case "status":
		if r.State == "queued" || r.State == "preparing" || r.State == "committing" {
			if err = s.beginHash(r); err != nil {
				return Response{}, err
			}
		}
		if r.State == "cancelled" && r.Direction == "upload" && s.jobs[r.key()] == nil {
			if err = s.deletePart(r); err != nil {
				return Response{}, err
			}
		}
		return r.snapshot(), nil
	case "cancel":
		if r.State == "complete" {
			return r.snapshot(), nil
		}
		if r.State == "committing" {
			f, partErr := s.part(r, unix.O_RDONLY)
			if f != nil {
				f.Close()
			}
			if errors.Is(partErr, os.ErrNotExist) {
				if err = s.beginHash(r); err != nil {
					return Response{}, err
				}
				return r.snapshot(), nil
			}
			if partErr != nil {
				return Response{}, partErr
			}
		}
		next := *r
		next.State = "cancelled"
		if err = s.save(r, next); err != nil {
			return Response{}, err
		}
		if cancel := s.jobs[r.key()]; cancel != nil {
			cancel()
		} else if r.Direction == "upload" {
			if err = s.deletePart(r); err != nil {
				return Response{}, err
			}
		}
		return r.snapshot(), nil
	case "upload-chunk":
		return s.upload(r, q)
	case "download-chunk":
		return s.download(r, q)
	case "finish":
		if r.Direction == "upload" {
			if r.Offset != r.Size {
				return Response{}, fail("OFFSET")
			}
			if r.State == "uploading" || r.State == "queued" || r.State == "committing" {
				if err = s.beginHash(r); err != nil {
					return Response{}, err
				}
			}
			if r.State != "verifying" && r.State != "queued" && r.State != "committing" && r.State != "complete" {
				return Response{}, fail("NOT_READY")
			}
		} else {
			if r.State != "ready" && r.State != "complete" {
				return Response{}, fail("NOT_READY")
			}
			if q.SHA256 != r.SHA256 {
				return Response{}, fail("HASH_MISMATCH")
			}
			next := *r
			next.State = "complete"
			next.Offset = r.Size
			if err = s.save(r, next); err != nil {
				return Response{}, err
			}
		}
		return r.snapshot(), nil
	default:
		return Response{}, fail("BAD_REQUEST")
	}
}

func (s *Store) list(q Request) (Response, error) {
	d, err := s.folder(q.Root, q.Path)
	if err != nil {
		return Response{}, err
	}
	defer d.close()
	type item struct {
		key   string
		entry Entry
	}
	items := []item{}
	more := false
	for {
		names, readErr := d.file.Readdirnames(128)
		if readErr != nil && readErr != io.EOF {
			return Response{}, readErr
		}
		for _, name := range names {
			if strings.HasPrefix(strings.ToLower(name), ".cliprelay-") {
				continue
			}
			st, err := d.stat(name)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return Response{}, err
			}
			if s.blocked[identity(&st)] {
				continue
			}
			isDir := st.Mode&unix.S_IFMT == unix.S_IFDIR
			key := "1:" + name
			if isDir {
				key = "0:" + name
			}
			if key <= q.After {
				continue
			}
			blocked := !safeName(name) || uint64(st.Dev) != d.key.Device || (!isDir && (st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1))
			size := int64(0)
			if st.Mode&unix.S_IFMT == unix.S_IFREG {
				size = st.Size
			}
			if size < 0 || size > MaxFileSize {
				blocked = true
				size = 0
			}
			entry := Entry{name, isDir, size, st.Mtim.Nano() / int64(time.Millisecond), blocked, strings.HasPrefix(name, ".")}
			position := sort.Search(len(items), func(i int) bool { return items[i].key >= key })
			// Preserve exact names on case-sensitive volumes. An entry observed
			// twice during concurrent directory changes is still emitted once.
			if position < len(items) && items[position].key == key {
				items[position].entry.Blocked = true
				continue
			}
			items = append(items, item{})
			copy(items[position+1:], items[position:])
			items[position] = item{key, entry}
			if len(items) > 256 {
				items = items[:256]
				more = true
			}
		}
		if readErr == io.EOF {
			break
		}
		if s.ctx.Err() != nil {
			return Response{}, fail("UNAVAILABLE")
		}
	}
	value := Response{OK: true, Root: q.Root, Path: q.Path, Entries: []Entry{}}
	for _, item := range items {
		value.Entries = append(value.Entries, item.entry)
	}
	if more && len(items) > 0 {
		value.Next = items[len(items)-1].key
	}
	return value, nil
}

func (s *Store) capacity() error {
	d, err := s.state.child(".")
	if err != nil {
		return err
	}
	defer d.close()
	count := 0
	for {
		names, readErr := d.file.Readdirnames(128)
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		for _, name := range names {
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			count++
			parts := strings.Split(strings.TrimSuffix(name, ".json"), "-")
			if len(parts) != 2 || !ownerPattern.MatchString(parts[0]) || !idPattern.MatchString(parts[1]) {
				continue
			}
			r, loadErr := s.load(parts[0], parts[1])
			if loadErr != nil || time.Since(time.UnixMilli(r.Updated)) < 7*24*time.Hour || s.jobs[r.key()] != nil || (r.State != "complete" && r.State != "cancelled") {
				continue
			}
			if r.State == "cancelled" && r.Direction == "upload" {
				if s.deletePart(r) != nil {
					continue
				}
			}
			st, statErr := d.stat(name)
			if statErr == nil && d.unlink(name, identity(&st)) == nil {
				delete(s.records, r.key())
				count--
			}
		}
		if readErr == io.EOF {
			break
		}
		if s.ctx.Err() != nil {
			return fail("UNAVAILABLE")
		}
	}
	if count >= 256 {
		return fail("QUEUE_FULL")
	}
	return nil
}

// DefaultOptions grants the desktop user's ordinary OS folders and excludes
// the entire application's private data directory, including pairing keys.
func DefaultOptions(stateDirectory string) (Options, error) {
	options := Options{Roots: map[string]string{}, ExcludedDirectories: []string{filepath.Dir(stateDirectory)}}
	parent, err := openDirectory(stateDirectory)
	if err != nil {
		return options, err
	}
	defer parent.close()
	if err = parent.private(); err != nil {
		return options, err
	}
	state, err := parent.privateChild("transfers")
	if err != nil {
		return options, err
	}
	state.close()
	options.StateDirectory = filepath.Join(stateDirectory, "transfers")
	home, err := os.UserHomeDir()
	if err != nil {
		return options, err
	}
	for id, path := range map[string]string{"home": home, "desktop": filepath.Join(home, "Desktop"), "documents": filepath.Join(home, "Documents"), "downloads": filepath.Join(home, "Downloads")} {
		canonical, err := filepath.EvalSymlinks(path)
		if err != nil {
			if id == "home" {
				return options, err
			}
			continue
		}
		d, err := openDirectory(canonical)
		if err != nil {
			if id == "home" {
				return options, err
			}
			continue
		}
		d.close()
		options.Roots[id] = canonical
	}
	return options, nil
}
