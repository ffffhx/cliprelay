//go:build darwin || linux

package hostfiles

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func (s *Store) start(q Request) (Response, error) {
	if !safeName(q.Name) {
		return Response{}, fail("BAD_PATH")
	}
	upload := q.Op == "upload-start"
	if upload && (q.Size == nil || !ownerPattern.MatchString(q.SHA256)) {
		return Response{}, fail("BAD_REQUEST")
	}
	d, err := s.folder(q.Root, q.Path)
	if err != nil {
		return Response{}, err
	}
	defer d.close()
	direction := "download"
	if upload {
		direction = "upload"
	}
	old, err := s.load(q.Owner, q.ID)
	if err == nil {
		if old.Root != q.Root || old.Directory != q.Path || old.Name != q.Name || old.Direction != direction || old.Folder != d.key ||
			(upload && (old.Size != *q.Size || old.SHA256 != q.SHA256)) {
			return Response{}, fail("ID_CONFLICT")
		}
		if old.State == "preparing" || old.State == "queued" || old.State == "committing" {
			if err = s.beginHash(old); err != nil {
				return Response{}, err
			}
		}
		return old.snapshot(), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Response{}, err
	}
	if err = s.capacity(); err != nil {
		return Response{}, err
	}
	r := &record{Owner: q.Owner, ID: q.ID, Root: q.Root, Directory: q.Path, Name: q.Name, Direction: direction, Folder: d.key}
	if upload {
		r.Size = *q.Size
		r.SHA256 = q.SHA256
		r.State = "uploading"
		stage, err := s.stage(q.Root)
		if err != nil {
			return Response{}, err
		}
		if err = stage.space(uint64(r.Size)); err != nil {
			return Response{}, err
		}
		f, st, err := stage.regular(partName(r), unix.O_RDWR|unix.O_CREAT|unix.O_EXCL, true)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				return Response{}, fail("ID_CONFLICT")
			}
			return Response{}, err
		}
		r.Part = identity(&st)
		syncErr := f.Sync()
		closeErr := f.Close()
		if syncErr == nil {
			syncErr = closeErr
		}
		if syncErr == nil {
			syncErr = stage.sync()
		}
		if syncErr != nil {
			_ = stage.unlink(partName(r), r.Part)
			return Response{}, syncErr
		}
		if err = s.save(r, *r); err != nil {
			_ = stage.unlink(partName(r), r.Part)
			return Response{}, err
		}
	} else {
		f, st, err := d.regular(q.Name, unix.O_RDONLY, false)
		if err != nil {
			return Response{}, err
		}
		f.Close()
		if st.Size < 0 || st.Size > MaxFileSize {
			return Response{}, fail("TOO_LARGE")
		}
		r.Size = st.Size
		r.Source = stamp(&st)
		r.State = "preparing"
		if err = s.save(r, *r); err != nil {
			return Response{}, err
		}
		if err = s.beginHash(r); err != nil {
			return Response{}, err
		}
	}
	return r.snapshot(), nil
}
func (s *Store) source(r *record) (*os.File, unix.Stat_t, error) {
	var st unix.Stat_t
	d, err := s.recordFolder(r)
	if err != nil {
		return nil, st, err
	}
	defer d.close()
	f, st, err := d.regular(r.Name, unix.O_RDONLY, false)
	if err != nil {
		return nil, st, err
	}
	if stamp(&st) != r.Source {
		f.Close()
		return nil, st, fail("SOURCE_CHANGED")
	}
	return f, st, nil
}
func (s *Store) upload(r *record, q Request) (Response, error) {
	if r.Direction != "upload" || r.State != "uploading" {
		return Response{}, fail("NOT_READY")
	}
	if q.Offset == nil {
		return Response{}, fail("BAD_REQUEST")
	}
	data, err := base64.StdEncoding.DecodeString(q.Data)
	if err != nil || base64.StdEncoding.EncodeToString(data) != q.Data || len(data) == 0 || len(data) > ChunkSize || *q.Offset < 0 || *q.Offset > r.Size-int64(len(data)) {
		return Response{}, fail("BAD_REQUEST")
	}
	if digest(data) != q.SHA256 {
		return Response{}, fail("HASH_MISMATCH")
	}
	// A journal cannot silently retarget an upload after the destination folder
	// was replaced, even though the part remains in the private staging area.
	d, err := s.recordFolder(r)
	if err != nil {
		return Response{}, err
	}
	d.close()
	f, err := s.part(r, unix.O_RDWR)
	if err != nil {
		return Response{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Response{}, err
	}
	if st.Size() < r.Offset {
		return Response{}, fail("INVALID_STATE")
	}
	if st.Size() > r.Offset {
		if err = f.Truncate(r.Offset); err != nil {
			return Response{}, err
		}
	}
	if *q.Offset < r.Offset {
		if *q.Offset+int64(len(data)) > r.Offset {
			return Response{}, fail("OFFSET")
		}
		old := make([]byte, len(data))
		n, readErr := f.ReadAt(old, *q.Offset)
		if readErr != nil || n != len(old) || !bytes.Equal(old, data) {
			return Response{}, fail("CHUNK_CONFLICT")
		}
		return r.snapshot(), nil
	}
	if *q.Offset != r.Offset {
		return Response{}, fail("OFFSET")
	}
	stage, err := s.stage(r.Root)
	if err != nil {
		return Response{}, err
	}
	if err = stage.space(uint64(len(data))); err != nil {
		return Response{}, err
	}
	if n, writeErr := f.WriteAt(data, *q.Offset); writeErr != nil {
		return Response{}, writeErr
	} else if n != len(data) {
		return Response{}, io.ErrShortWrite
	}
	if err = f.Sync(); err != nil {
		return Response{}, err
	}
	next := *r
	next.Offset += int64(len(data))
	if err = s.save(r, next); err != nil {
		return Response{}, err
	}
	return r.snapshot(), nil
}
func (s *Store) download(r *record, q Request) (Response, error) {
	if r.Direction != "download" || (r.State != "ready" && r.State != "complete") {
		return Response{}, fail("NOT_READY")
	}
	if q.Offset == nil || *q.Offset < 0 || *q.Offset > r.Size {
		return Response{}, fail("OFFSET")
	}
	f, _, err := s.source(r)
	if err != nil {
		return Response{}, err
	}
	defer f.Close()
	size := min(int64(ChunkSize), r.Size-*q.Offset)
	data := make([]byte, int(size))
	n, err := f.ReadAt(data, *q.Offset)
	if n != len(data) || (err != nil && err != io.EOF) {
		return Response{}, fail("SOURCE_CHANGED")
	}
	var st unix.Stat_t
	if err = unix.Fstat(int(f.Fd()), &st); err != nil {
		return Response{}, err
	}
	if stamp(&st) != r.Source {
		return Response{}, fail("SOURCE_CHANGED")
	}
	return Response{OK: true, ID: r.ID, Offset: *q.Offset, Size: r.Size, Data: base64.StdEncoding.EncodeToString(data), SHA256: digest(data)}, nil
}
