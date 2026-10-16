package hostterminal

import (
	"errors"
	"sync"
)

const mouseLeaseMs int64 = 1500
const mouseStallMs int64 = 5000

type MouseCommand struct {
	Action    string `json:"action"`
	Sequence  int64  `json:"sequence"`
	Epoch     int64  `json:"epoch"`
	Gesture   int64  `json:"gesture"`
	Column    int    `json:"column"`
	Row       int    `json:"row"`
	Button    int    `json:"button"`
	Modifiers int    `json:"modifiers"`
}
type MouseState struct {
	Mode             int    `json:"mode"`
	Format           int    `json:"format"`
	Buttons          int    `json:"buttons"`
	RemainingMs      int64  `json:"remainingMs"`
	Epoch            int64  `json:"epoch"`
	Offset           int64  `json:"offset"`
	Gesture          int64  `json:"gesture"`
	NextGesture      int64  `json:"nextGesture"`
	AcceptedSequence int64  `json:"acceptedSequence"`
	WrittenSequence  int64  `json:"writtenSequence"`
	Phase            string `json:"phase"`
	Outcome          string `json:"outcome"`
}

// InputItem is owned by the queue. One writer may read Data/Paste between
// Begin and Complete. Other fields remain private and protected by the mutex.
type InputItem struct {
	Data                           []byte
	Paste                          bool
	sequence, epoch, gesture       int64
	expires                        int64
	mouse, cleanup                 bool
	action                         string
	button, modifiers, column, row int
}

// InputQueue orders keyboard, whole-paste and typed mouse input. Expired
// gestures reserve cleanup capacity ahead of ordinary input; only Complete
// confirms native writes. No retry renews a lease or replays an input event.
type InputQueue struct {
	mu                                         sync.Mutex
	now                                        func() int64
	modes                                      MouseModes
	pending                                    []*InputItem
	columns, rows                              int
	rawBytes, rawCount, mouseCount             int
	desiredButtons, writtenButtons             int
	lastColumns, lastRows, lastModifiers       [3]int
	accepted, written, keyboardWritten         int64
	nextGesture, gesture, leaseEpoch, deadline int64
	cleanupAt, inFlightAt                      int64
	last                                       MouseCommand
	phase, outcome                             string
	stopped, closedLease, cleanup, abort       bool
	inFlight                                   *InputItem
	Changed                                    chan struct{}
}

func NewInputQueue(now func() int64, columns, rows int) *InputQueue {
	return &InputQueue{now: now, columns: columns, rows: rows, modes: newMouseModes(), nextGesture: 1, phase: "idle", outcome: "none", Changed: make(chan struct{}, 1)}
}
func (q *InputQueue) signal() {
	select {
	case q.Changed <- struct{}{}:
	default:
	}
}
func (q *InputQueue) Observe(data []byte, output func([]byte)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.stopped {
		epoch := q.modes.Epoch
		q.modes.Feed(data)
		if epoch != q.modes.Epoch {
			q.cancel("mode-changed", true)
		}
	}
	// Retain output before exposing its mode/byte offset to a state reader.
	output(data)
	q.signal()
}
func (q *InputQueue) Queue(data []byte, sequence int64, paste bool) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	limit := 4096
	if paste {
		limit = PasteLimit
	}
	if q.stopped || q.abort || sequence < 1 || sequence > MaxSequence || len(data) == 0 || len(data) > limit || q.rawBytes+len(data) > 32768 || q.rawCount >= 8 {
		return false
	}
	q.pending = append(q.pending, &InputItem{Data: append([]byte(nil), data...), sequence: sequence, Paste: paste})
	q.rawBytes += len(data)
	q.rawCount++
	q.signal()
	return true
}
func (q *InputQueue) Mouse(c MouseCommand) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tick()
	if q.stopped || q.abort {
		return errors.New("TERMINAL_CLOSED")
	}
	if c.Sequence < 1 || c.Sequence > MaxSequence {
		return errors.New("TERMINAL_BAD_REQUEST")
	}
	if c.Sequence == q.accepted {
		if c != q.last {
			return errors.New("TERMINAL_MOUSE_CONFLICT")
		}
		return nil
	}
	if c.Sequence != q.accepted+1 {
		return errors.New("TERMINAL_MOUSE_SEQUENCE")
	}
	if c.Epoch != q.modes.Epoch {
		return errors.New("TERMINAL_MOUSE_MODE")
	}
	if c.Action == "renew" || c.Action == "cancel" {
		if c.Column != 0 || c.Row != 0 || c.Button != 0 || c.Modifiers != 0 {
			return errors.New("TERMINAL_BAD_REQUEST")
		}
		if c.Gesture <= 0 || c.Gesture != q.gesture || q.closedLease {
			return errors.New("TERMINAL_MOUSE_GESTURE")
		}
		if c.Action == "renew" {
			if q.desiredButtons == 0 {
				return errors.New("TERMINAL_MOUSE_GESTURE")
			}
			q.deadline, q.outcome = q.now()+mouseLeaseMs, "renewed"
		} else {
			q.cancel("cancelled", false)
			q.outcome = "cancelled"
		}
		q.accepted, q.last = c.Sequence, c
		q.signal()
		return nil
	}
	if !q.modes.Enabled() {
		return errors.New("TERMINAL_MOUSE_MODE")
	}
	if q.cleanup {
		return errors.New("TERMINAL_BUSY")
	}
	columnLimit, rowLimit := q.columns, q.rows
	if q.modes.Format == 1016 {
		columnLimit, rowLimit = 65535, 65535
	}
	if c.Column < 1 || c.Row < 1 || c.Column > columnLimit || c.Row > rowLimit {
		return errors.New("TERMINAL_BAD_REQUEST")
	}
	data, err := encodeMouse(q.modes.Mode, q.modes.Format, c.Action, c.Button, c.Modifiers, c.Column, c.Row)
	if err != nil {
		return err
	}
	if q.mouseCount >= 64 {
		return errors.New("TERMINAL_BUSY")
	}
	noLease := q.modes.Mode == 9 || c.Action == "wheel" || c.Action == "move" && c.Button == 3
	if noLease {
		if c.Gesture != 0 || c.Action == "move" && (q.desiredButtons != 0 || q.writtenButtons != 0) {
			return errors.New("TERMINAL_MOUSE_GESTURE")
		}
	} else if c.Action == "press" {
		if q.desiredButtons&(1<<c.Button) != 0 {
			return errors.New("TERMINAL_MOUSE_GESTURE")
		}
		if q.closedLease || q.desiredButtons == 0 {
			if q.gesture != 0 && !q.closedLease || q.writtenButtons != 0 || q.inFlight != nil && q.inFlight.mouse && q.inFlight.gesture != 0 {
				return errors.New("TERMINAL_BUSY")
			}
			if c.Gesture != q.nextGesture || q.nextGesture >= MaxSequence {
				return errors.New("TERMINAL_MOUSE_GESTURE")
			}
			q.gesture, q.leaseEpoch = q.nextGesture, q.modes.Epoch
			q.nextGesture++
			q.closedLease, q.phase = false, "pending"
		} else if c.Gesture != q.gesture {
			return errors.New("TERMINAL_MOUSE_GESTURE")
		}
		q.desiredButtons |= 1 << c.Button
		q.deadline = q.now() + mouseLeaseMs
	} else {
		if q.closedLease || c.Gesture != q.gesture || q.desiredButtons&(1<<c.Button) == 0 {
			return errors.New("TERMINAL_MOUSE_GESTURE")
		}
		if c.Action == "release" {
			q.desiredButtons &^= 1 << c.Button
		}
		q.deadline = q.now() + mouseLeaseMs
	}
	q.accepted, q.last, q.outcome = c.Sequence, c, "queued"
	gesture := q.gesture
	if noLease {
		gesture = 0
	}
	q.pending = append(q.pending, &InputItem{Data: data, sequence: c.Sequence, mouse: true, epoch: q.modes.Epoch, gesture: gesture, expires: q.now() + mouseLeaseMs, action: c.Action, button: c.Button, column: c.Column, row: c.Row, modifiers: c.Modifiers})
	q.mouseCount++
	q.signal()
	return nil
}
func (q *InputQueue) filter(remove func(*InputItem) bool) {
	kept := q.pending[:0]
	for _, item := range q.pending {
		if remove(item) {
			q.mouseCount--
		} else {
			kept = append(kept, item)
		}
	}
	clear(q.pending[len(kept):])
	q.pending = kept
}
func (q *InputQueue) cancel(reason string, all bool) {
	hadLease := !q.closedLease && q.gesture != 0 || q.writtenButtons != 0 || q.inFlight != nil && q.inFlight.mouse && q.inFlight.gesture != 0
	q.filter(func(item *InputItem) bool {
		if item.mouse && (all || item.gesture == q.gesture && item.gesture != 0) {
			if item.sequence == q.accepted {
				q.outcome = reason
			}
			return true
		}
		return false
	})
	q.desiredButtons, q.closedLease = 0, true
	if hadLease {
		q.phase = reason
		if !all && (q.writtenButtons != 0 || q.inFlight != nil && q.inFlight.mouse && q.inFlight.gesture == q.gesture) {
			if !q.cleanup {
				q.cleanupAt = q.now()
			}
			q.cleanup = true
		}
	}
	if all {
		q.cleanup, q.writtenButtons = false, 0
	}
}
func (q *InputQueue) tick() {
	now := q.now()
	if !q.closedLease && q.gesture != 0 && now >= q.deadline {
		q.cancel("expired", false)
	}
	q.filter(func(item *InputItem) bool {
		if item.mouse && item.gesture == 0 && now >= item.expires {
			if item.sequence == q.accepted {
				q.outcome = "expired"
			}
			return true
		}
		return false
	})
	if q.cleanup && now-q.cleanupAt >= mouseStallMs || q.inFlight != nil && now-q.inFlightAt >= mouseStallMs && (q.writtenButtons != 0 || q.inFlight.mouse && q.inFlight.gesture != 0) {
		q.abort = true
	}
}
func (q *InputQueue) AbortRequired() bool { q.mu.Lock(); defer q.mu.Unlock(); q.tick(); return q.abort }
func (q *InputQueue) State() MouseState {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tick()
	remaining := int64(0)
	if !q.closedLease && q.gesture != 0 {
		remaining = max(0, q.deadline-q.now())
	}
	return MouseState{Mode: q.modes.Mode, Format: q.modes.Format, Epoch: q.modes.Epoch, Offset: q.modes.ChangedAt, Gesture: q.gesture, NextGesture: q.nextGesture, Buttons: q.writtenButtons, RemainingMs: remaining, AcceptedSequence: q.accepted, WrittenSequence: q.written, Phase: q.phase, Outcome: q.outcome}
}
func (q *InputQueue) KeyboardWritten() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.keyboardWritten
}
func (q *InputQueue) Begin() *InputItem {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tick()
	if q.stopped || q.abort || q.inFlight != nil {
		return nil
	}
	var item *InputItem
	if q.cleanup {
		if q.writtenButtons != 0 && q.leaseEpoch == q.modes.Epoch && q.modes.Enabled() {
			var data []byte
			for button := 0; button < 3; button++ {
				if q.writtenButtons&(1<<button) == 0 {
					continue
				}
				column, row := q.lastColumns[button], q.lastRows[button]
				if q.modes.Format != 1016 {
					column, row = min(q.columns, column), min(q.rows, row)
				}
				part, err := encodeMouse(q.modes.Mode, q.modes.Format, "release", button, q.lastModifiers[button], column, row)
				if err != nil {
					q.abort = true
					return nil
				}
				data = append(data, part...)
				if q.modes.Format != 1006 && q.modes.Format != 1016 {
					break
				}
			}
			item = &InputItem{Data: data, mouse: true, cleanup: true, gesture: q.gesture, epoch: q.modes.Epoch}
		} else {
			q.cleanup = false
		}
	}
	if item == nil && len(q.pending) > 0 {
		item = q.pending[0]
		q.pending[0] = nil
		q.pending = q.pending[1:]
	}
	if item != nil {
		q.inFlight, q.inFlightAt = item, q.now()
	}
	return item
}
func (q *InputQueue) Complete(item *InputItem) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if item == nil || item != q.inFlight {
		return errors.New("TERMINAL_UNAVAILABLE")
	}
	q.inFlight = nil
	if q.stopped {
		if !item.mouse {
			q.keyboardWritten = item.sequence
		} else if !item.cleanup {
			q.written = item.sequence
		}
		q.signal()
		return nil
	}
	if !item.mouse {
		q.rawBytes -= len(item.Data)
		q.rawCount--
		q.keyboardWritten = item.sequence
	} else if item.cleanup {
		q.writtenButtons, q.cleanup = 0, false
	} else {
		q.mouseCount--
		q.written = item.sequence
		if item.sequence == q.accepted {
			q.outcome = "written"
		}
		if item.gesture != 0 && item.epoch == q.modes.Epoch {
			if item.action == "press" {
				q.writtenButtons |= 1 << item.button
			} else if item.action == "release" {
				q.writtenButtons &^= 1 << item.button
			}
			q.lastColumns[item.button], q.lastRows[item.button], q.lastModifiers[item.button] = item.column, item.row, item.modifiers
			if q.closedLease && q.writtenButtons != 0 {
				if !q.cleanup {
					q.cleanupAt = q.now()
				}
				q.cleanup = true
			} else if q.writtenButtons != 0 {
				q.phase = "held"
			} else if q.desiredButtons == 0 {
				q.closedLease, q.phase = true, "idle"
			}
		}
	}
	q.tick()
	q.signal()
	return nil
}
func (q *InputQueue) Resize(columns, rows int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	previousEpoch := q.modes.Epoch
	q.columns, q.rows = columns, rows
	q.cancel("cancelled", false)
	q.filter(func(item *InputItem) bool {
		if item.mouse {
			if item.sequence == q.accepted {
				q.outcome = "cancelled"
			}
			return true
		}
		return false
	})
	q.modes.invalidateGrid()
	q.leaseEpoch = q.modes.Epoch
	// An already-started native press may finish after resize. Only a press
	// from the same mode epoch can be adopted for cleanup in the resized grid.
	if q.inFlight != nil && q.inFlight.mouse && q.inFlight.gesture != 0 && q.inFlight.epoch == previousEpoch {
		q.inFlight.epoch = q.modes.Epoch
	}
	q.signal()
}
func (q *InputQueue) Stop() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.stopped, q.closedLease, q.cleanup = true, true, false
	q.pending = nil
	q.desiredButtons, q.writtenButtons = 0, 0
	q.phase = "closed"
	q.signal()
}
