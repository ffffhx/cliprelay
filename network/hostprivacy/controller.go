// Package hostprivacy owns only the native mask's private process protocol.
// Pairing, exclusive stream ownership and engine exclusion are checked by the
// host broker before it sends activate. This protocol is never an HTTP handler.
package hostprivacy

import (
	"errors"
	"regexp"
	"sync"
	"time"
)

const Lifetime = 15 * time.Second

var leasePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Window struct {
	ID      uint32 `json:"id"`
	Display uint32 `json:"display"`
}

type Identity struct {
	PID       int      `json:"pid"`
	BirthSec  uint64   `json:"birthSec"`
	BirthUsec uint32   `json:"birthUsec"`
	Windows   []Window `json:"windows"`
}

type Desktop interface {
	// Prepare creates invisible masks. It must not reveal them before Show.
	Prepare() (Identity, error)
	Show() error
	Healthy() bool
	Hide() error
}

type Request struct {
	Op    string `json:"op"`
	Lease string `json:"lease,omitempty"`
}

type Response struct {
	OK        bool      `json:"ok"`
	Code      string    `json:"code,omitempty"`
	Supported bool      `json:"supported"`
	Prepared  bool      `json:"prepared"`
	Active    bool      `json:"active"`
	Lease     string    `json:"lease,omitempty"`
	ExpiresMs int64     `json:"expiresMs"`
	Identity  *Identity `json:"identity,omitempty"`
}

// Handle has one protocol reader. The separate deadline lock is never held
// across an AppKit call, so a stalled UI cannot block the process watchdog.
type Controller struct {
	desktop         Desktop
	now             func() time.Time
	lease           string
	active          bool
	identity        *Identity
	deadlineMu      sync.Mutex
	deadline        time.Time
	withdrawn       chan struct{}
	withdrawOnce    sync.Once
	deadlineChanged chan struct{}
}

func New(desktop Desktop, now func() time.Time) *Controller {
	return &Controller{desktop: desktop, now: now, withdrawn: make(chan struct{}), deadlineChanged: make(chan struct{}, 1)}
}

func (c *Controller) Withdrawn() <-chan struct{}       { return c.withdrawn }
func (c *Controller) Withdraw()                        { c.withdrawOnce.Do(func() { close(c.withdrawn) }) }
func (c *Controller) DeadlineChanged() <-chan struct{} { return c.deadlineChanged }

func (c *Controller) Deadline() time.Time {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()
	return c.deadline
}

func (c *Controller) setDeadline(value time.Time) {
	c.deadlineMu.Lock()
	c.deadline = value
	c.deadlineMu.Unlock()
	select {
	case c.deadlineChanged <- struct{}{}:
	default:
	}
}

func (c *Controller) live() bool {
	return c.lease != "" && c.now().Before(c.Deadline())
}

func (c *Controller) clear() error {
	// Leave the watchdog armed until the native mask is actually hidden.
	if err := c.desktop.Hide(); err != nil {
		return errors.New("PRIVACY_RESTORE_FAILED")
	}
	c.lease, c.active, c.identity = "", false, nil
	c.setDeadline(time.Time{})
	return nil
}

func (c *Controller) Close() error { return c.clear() }

func (c *Controller) state() Response {
	result := Response{OK: true, Supported: true}
	if c.live() {
		result.Prepared, result.Active, result.Lease = true, c.active, c.lease
		result.ExpiresMs = int64((c.Deadline().Sub(c.now()) + time.Millisecond - 1) / time.Millisecond)
		if result.ExpiresMs < 1 {
			result.ExpiresMs = 1
		}
		result.Identity = c.identity
	}
	return result
}

func invalid(code string) Response { return Response{Supported: true, Code: code} }

func validIdentity(value Identity) bool {
	if value.PID <= 1 || value.BirthSec == 0 || value.BirthUsec >= 1000000 || len(value.Windows) == 0 || len(value.Windows) > 16 {
		return false
	}
	windows, displays := map[uint32]bool{}, map[uint32]bool{}
	for _, window := range value.Windows {
		if window.ID == 0 || window.Display == 0 || windows[window.ID] || displays[window.Display] {
			return false
		}
		windows[window.ID], displays[window.Display] = true, true
	}
	return true
}

func (c *Controller) Handle(request Request) (Response, error) {
	if request.Op == "status" {
		if request.Lease != "" {
			return invalid("PRIVACY_BAD_REQUEST"), nil
		}
		if c.lease != "" && !c.live() {
			if err := c.clear(); err != nil {
				return Response{}, err
			}
		}
		return c.state(), nil
	}
	if !leasePattern.MatchString(request.Lease) {
		return invalid("PRIVACY_BAD_REQUEST"), nil
	}
	switch request.Op {
	case "prepare", "activate", "renew", "stop":
	default:
		return invalid("PRIVACY_BAD_REQUEST"), nil
	}
	if c.lease != "" && c.lease != request.Lease {
		return invalid("PRIVACY_BUSY"), nil
	}
	if request.Op == "stop" {
		if err := c.clear(); err != nil {
			return Response{}, err
		}
		return c.state(), nil
	}
	if c.lease != "" && !c.live() {
		if err := c.clear(); err != nil {
			return Response{}, err
		}
		return invalid("PRIVACY_EXPIRED"), nil
	}
	if request.Op == "prepare" {
		if c.lease != "" {
			return c.state(), nil
		} // A replay does not renew authority.
		c.lease = request.Lease
		c.setDeadline(c.now().Add(Lifetime))
		identity, err := c.desktop.Prepare()
		if err != nil || !validIdentity(identity) || !c.live() {
			if err := c.clear(); err != nil {
				return Response{}, err
			}
			return invalid("PRIVACY_DESKTOP_UNAVAILABLE"), nil
		}
		identity.Windows = append([]Window(nil), identity.Windows...)
		c.identity = &identity
		return c.state(), nil
	}
	if c.lease == "" {
		return invalid("PRIVACY_EXPIRED"), nil
	}
	if request.Op == "activate" {
		if !c.active {
			if err := c.desktop.Show(); err != nil || !c.live() {
				if err := c.clear(); err != nil {
					return Response{}, err
				}
				return invalid("PRIVACY_DESKTOP_UNAVAILABLE"), nil
			}
			c.active = true
		}
		return c.state(), nil // Activation never extends the preparation deadline.
	}
	if !c.active {
		return invalid("PRIVACY_EXPIRED"), nil
	}
	if !c.desktop.Healthy() || !c.live() {
		if err := c.clear(); err != nil {
			return Response{}, err
		}
		return invalid("PRIVACY_DESKTOP_UNAVAILABLE"), nil
	}
	c.setDeadline(c.now().Add(Lifetime))
	return c.state(), nil
}
