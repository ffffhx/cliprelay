package inputfocus

import (
	"cliprelay/network/hostprivacy"
	"context"
	"encoding/json"
)

type privacyProcess struct{ probe *probe }

func (w *privacyProcess) Read(ctx context.Context, request hostprivacy.Request) (hostprivacy.Response, error) {
	raw, _ := json.Marshal(request)
	response, err := w.probe.readWithContext(ctx, string(raw))
	if err != nil {
		return hostprivacy.Response{}, err
	}
	var value hostprivacy.Response
	if err := decodePrivacyJSON(response, &value, 8192); err != nil {
		return hostprivacy.Response{}, err
	}
	return value, nil
}
func (w *privacyProcess) PID() int {
	w.probe.mu.Lock()
	defer w.probe.mu.Unlock()
	if w.probe.cmd == nil || w.probe.closed {
		return 0
	}
	return w.probe.cmd.Process.Pid
}
func (w *privacyProcess) Alive() bool {
	w.probe.mu.Lock()
	defer w.probe.mu.Unlock()
	if w.probe.cmd == nil || w.probe.closed || w.probe.exitDone == nil {
		return false
	}
	select {
	case <-w.probe.exitDone:
		return false
	default:
		return true
	}
}
func (w *privacyProcess) Close() error { w.probe.close(); return nil }
