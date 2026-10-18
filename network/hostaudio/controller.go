// Package hostaudio owns a private Mac audio-mute worker. The paired host
// controller admits the sole live stream before sending any start command.
package hostaudio

import (
	"errors"
	"regexp"
	"sync"
	"time"
)

const Lifetime = 15 * time.Second

var leasePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Output never changes a hardware volume, mute flag, default route or format.
// Start owns a global muted Core Audio tap; Stop destroys only that tap.
type Output interface {
	Outputs() (int, error)
	Start() error
	Healthy() bool
	Stop() error
}

type Request struct {
	Op    string `json:"op"`
	Lease string `json:"lease,omitempty"`
}

type Response struct {
	OK         bool   `json:"ok"`
	Code       string `json:"code,omitempty"`
	Supported  bool   `json:"supported"`
	Active     bool   `json:"active"`
	Recovering bool   `json:"recovering"`
	Outputs    int    `json:"outputs"`
	Lease      string `json:"lease,omitempty"`
	ExpiresMs  int64  `json:"expiresMs"`
}

// One reader serializes Handle and Close. The watchdog only reads Deadline,
// whose lock is never held across native calls or pipe writes.
type Controller struct {
	output       Output
	now          func() time.Time
	lease        string
	active       bool
	retired      map[string]time.Time
	deadlineMu   sync.Mutex
	deadline     time.Time
	changed      chan struct{}
	withdrawn    chan struct{}
	withdrawOnce sync.Once
}

func New(output Output, now func() time.Time) *Controller {
	return &Controller{output: output, now: now, retired: map[string]time.Time{}, changed: make(chan struct{}, 1), withdrawn: make(chan struct{})}
}
func (c *Controller) Deadline() time.Time {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()
	return c.deadline
}
func (c *Controller) DeadlineChanged() <-chan struct{} { return c.changed }
func (c *Controller) Withdrawn() <-chan struct{}       { return c.withdrawn }
func (c *Controller) Withdraw()                        { c.withdrawOnce.Do(func() { close(c.withdrawn) }) }
func (c *Controller) setDeadline(value time.Time) {
	c.deadlineMu.Lock()
	c.deadline = value
	c.deadlineMu.Unlock()
	select {
	case c.changed <- struct{}{}:
	default:
	}
}
func (c *Controller) live() bool { return c.lease != "" && c.now().Before(c.Deadline()) }
func (c *Controller) Close() error {
	// Keep the deadline armed if native cleanup blocks or fails. The native
	// runner's independent watchdog ends the owning process as a last resort.
	if err := c.output.Stop(); err != nil {
		return errors.New("AUDIO_RECOVERY_PENDING")
	}
	if c.lease != "" {
		c.retired[c.lease] = c.now().Add(2 * time.Minute)
	}
	c.lease = ""
	c.active = false
	c.setDeadline(time.Time{})
	return nil
}
func (c *Controller) state() Response {
	outputs, err := c.output.Outputs()
	if err != nil || outputs < 0 || outputs > 32 {
		return Response{Code: "AUDIO_UNAVAILABLE"}
	}
	value := Response{OK: true, Supported: outputs > 0, Outputs: outputs}
	if c.live() && c.active {
		value.Active = true
		value.Lease = c.lease
		value.ExpiresMs = int64((c.Deadline().Sub(c.now()) + time.Millisecond - 1) / time.Millisecond)
		if value.ExpiresMs < 1 {
			value.ExpiresMs = 1
		}
	}
	return value
}
func invalid(code string) Response { return Response{Code: code} }
func (c *Controller) Handle(q Request) (Response, error) {
	if q.Op == "status" {
		if q.Lease != "" {
			return invalid("AUDIO_BAD_REQUEST"), nil
		}
	} else if (q.Op != "start" && q.Op != "renew" && q.Op != "stop") || !leasePattern.MatchString(q.Lease) {
		return invalid("AUDIO_BAD_REQUEST"), nil
	}
	for lease, until := range c.retired {
		if !c.now().Before(until) {
			delete(c.retired, lease)
		}
	}
	if c.lease != "" && (!c.live() || !c.output.Healthy()) {
		if err := c.Close(); err != nil {
			return Response{}, err
		}
	}
	if q.Op == "status" {
		return c.state(), nil
	}
	if c.lease != "" && c.lease != q.Lease {
		return invalid("AUDIO_BUSY"), nil
	}
	if q.Op == "stop" {
		if _, exists := c.retired[q.Lease]; !exists && len(c.retired) >= 256 {
			return invalid("AUDIO_BUSY"), nil
		}
		c.retired[q.Lease] = c.now().Add(2 * time.Minute)
		if c.lease == q.Lease {
			if err := c.Close(); err != nil {
				return Response{}, err
			}
		}
		return c.state(), nil
	}
	if _, retired := c.retired[q.Lease]; retired {
		return invalid("AUDIO_EXPIRED"), nil
	}
	if q.Op == "renew" && !c.live() {
		return invalid("AUDIO_EXPIRED"), nil
	}
	if q.Op == "start" && c.live() {
		return c.state(), nil
	} // A replay cannot extend its lease.
	if q.Op == "start" {
		if len(c.retired) >= 256 {
			return invalid("AUDIO_BUSY"), nil
		}
		state := c.state()
		if !state.OK {
			return state, nil
		}
		if !state.Supported {
			return invalid("AUDIO_UNSUPPORTED"), nil
		}
		c.lease = q.Lease
		c.setDeadline(c.now().Add(Lifetime))
		if err := c.output.Start(); err != nil || !c.output.Healthy() {
			if err := c.Close(); err != nil {
				return Response{}, err
			}
			return invalid("AUDIO_UNAVAILABLE"), nil
		}
		if !c.live() {
			if err := c.Close(); err != nil {
				return Response{}, err
			}
			return invalid("AUDIO_EXPIRED"), nil
		}
		c.active = true
	} else {
		c.setDeadline(c.now().Add(Lifetime))
	}
	return c.state(), nil
}
