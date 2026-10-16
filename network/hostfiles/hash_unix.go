//go:build darwin || linux

package hostfiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func (s *Store) hashInput(r *record) (*os.File, unix.Stat_t, bool, error) {
	var st unix.Stat_t
	if r.Direction == "download" {
		f, stat, err := s.source(r)
		return f, stat, false, err
	}
	f, err := s.part(r, unix.O_RDONLY)
	recovering := r.State == "committing" && errors.Is(err, os.ErrNotExist)
	if recovering {
		var d *directory
		d, err = s.recordFolder(r)
		if err != nil {
			return nil, st, true, err
		}
		defer d.close()
		f, st, err = d.regular(r.FinalName, unix.O_RDONLY, false)
		if err == nil && identity(&st) != r.Part {
			f.Close()
			return nil, st, true, fail("INVALID_STATE")
		}
	} else if err == nil {
		err = unix.Fstat(int(f.Fd()), &st)
	}
	if err == nil && st.Size != r.Size {
		err = fail("INVALID_STATE")
	}
	if err != nil {
		if f != nil {
			f.Close()
		}
		return nil, st, recovering, err
	}
	return f, st, recovering, nil
}
func (s *Store) beginHash(r *record) error {
	if s.jobs[r.key()] != nil {
		return nil
	}
	if len(s.jobs) >= 2 {
		if r.State != "committing" && r.State != "queued" {
			next := *r
			next.State = "queued"
			return s.save(r, next)
		}
		return nil
	}
	if r.Direction == "upload" && r.Offset != r.Size {
		return fail("OFFSET")
	}
	f, st, recovering, err := s.hashInput(r)
	if err != nil {
		return err
	}
	next := *r
	next.State = "verifying"
	if recovering {
		next.State = "committing"
	}
	next.Verified = 0
	next.Code = ""
	if err = s.save(r, next); err != nil {
		f.Close()
		return err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.jobs[r.key()] = cancel
	s.workers.Add(1)
	go s.verify(ctx, r, f, stamp(&st), recovering)
	return nil
}
func (s *Store) verify(ctx context.Context, r *record, f *os.File, before fingerprint, recovering bool) {
	defer s.workers.Done()
	defer f.Close()
	hash := sha256.New()
	buffer := make([]byte, 1024*1024)
	total := int64(0)
	var verifyErr error
	for {
		if ctx.Err() != nil {
			break
		}
		n, err := f.Read(buffer)
		if n > 0 {
			total += int64(n)
			if total > before.Size {
				verifyErr = fail("SOURCE_CHANGED")
				break
			}
			_, _ = hash.Write(buffer[:n])
			s.mu.Lock()
			if !s.closed && s.records[r.key()] == r && r.State != "cancelled" {
				r.Verified = total
			}
			s.mu.Unlock()
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			verifyErr = err
			break
		}
	}
	if verifyErr == nil && ctx.Err() == nil {
		var after unix.Stat_t
		verifyErr = unix.Fstat(int(f.Fd()), &after)
		if verifyErr == nil && (stamp(&after) != before || total != before.Size) {
			verifyErr = fail("SOURCE_CHANGED")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cancelled := ctx.Err() != nil
	if cancel := s.jobs[r.key()]; cancel != nil {
		cancel()
		delete(s.jobs, r.key())
	}
	if s.closed || s.records[r.key()] != r {
		return
	}
	if r.State == "cancelled" {
		if r.Direction == "upload" {
			_ = s.deletePart(r)
		}
		return
	}
	if cancelled {
		return
	}
	if verifyErr == nil {
		value := hex.EncodeToString(hash.Sum(nil))
		if r.Direction == "upload" {
			if value != r.SHA256 {
				verifyErr = fail("HASH_MISMATCH")
			} else if recovering {
				// A matching pathname/hash alone is insufficient: hashInput also
				// requires the original staged inode from the durable journal.
				verifyErr = f.Sync()
				if verifyErr == nil {
					var d *directory
					d, verifyErr = s.recordFolder(r)
					if verifyErr == nil {
						verifyErr = d.sync()
						d.close()
					}
				}
				if verifyErr == nil {
					next := *r
					next.State = "complete"
					verifyErr = s.save(r, next)
				}
			} else {
				verifyErr = s.commit(r, before)
			}
		} else {
			next := *r
			next.SHA256 = value
			next.State = "ready"
			verifyErr = s.save(r, next)
		}
	}
	if verifyErr != nil {
		// Keep an uncertain completed rename recoverable. Never delete or
		// replace a published destination in response to a failed receipt.
		code := errorCode(verifyErr)
		if r.State != "committing" || code == "FILES_HASH_MISMATCH" || code == "FILES_INVALID_STATE" || code == "FILES_SOURCE_CHANGED" {
			next := *r
			next.State = "error"
			next.Code = code
			_ = s.save(r, next)
		}
	}
}
func collisionName(name string, number int) (string, error) {
	if number == 0 {
		return name, nil
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" {
		stem = name
		ext = ""
	}
	suffix := " (" + strconv.Itoa(number) + ")"
	runes := []rune(stem)
	for len(runes) > 0 {
		candidate := string(runes) + suffix + ext
		if safeName(candidate) {
			return candidate, nil
		}
		runes = runes[:len(runes)-1]
	}
	return "", fail("EXISTS")
}
func (s *Store) commit(r *record, verified fingerprint) error {
	stage, err := s.stage(r.Root)
	if err != nil {
		return err
	}
	d, err := s.recordFolder(r)
	if err != nil {
		return err
	}
	defer d.close()
	if stage.key.Device != d.key.Device {
		return fail("BAD_PATH")
	}
	for number := 0; number < 10000; number++ {
		candidate, err := collisionName(r.Name, number)
		if err != nil {
			return err
		}
		next := *r
		next.State = "committing"
		next.FinalName = candidate
		if err = s.save(r, next); err != nil {
			return err
		}
		if err = renameExclusive(stage, partName(r), d, candidate); errors.Is(err, os.ErrExist) {
			continue
		} else if err != nil {
			return err
		}
		f, st, err := d.regular(candidate, unix.O_RDONLY, false)
		if err != nil {
			return err
		}
		f.Close()
		if identity(&st) != r.Part || st.Size != verified.Size || st.Mtim.Nano() != verified.Modified {
			return fail("INVALID_STATE")
		}
		if err = stage.sync(); err != nil {
			return err
		}
		if err = d.sync(); err != nil {
			return err
		}
		next = *r
		next.State = "complete"
		return s.save(r, next)
	}
	return fail("EXISTS")
}
