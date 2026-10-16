package hostterminal

import "encoding/json"

func initialMouseState() MouseState {
	return MouseState{Epoch: 1, NextGesture: 1, Phase: "idle", Outcome: "none"}
}
func validMouseCommand(c MouseCommand) bool {
	if c.Sequence < 1 || c.Sequence > MaxSequence || c.Epoch < 1 || c.Epoch > MaxSequence || c.Gesture < 0 || c.Gesture >= MaxSequence {
		return false
	}
	if c.Action == "renew" || c.Action == "cancel" {
		return c.Gesture > 0 && c.Column == 0 && c.Row == 0 && c.Button == 0 && c.Modifiers == 0
	}
	if c.Column < 1 || c.Column > 65535 || c.Row < 1 || c.Row > 65535 || c.Modifiers < 0 || c.Modifiers > 28 || c.Modifiers%4 != 0 {
		return false
	}
	switch c.Action {
	case "press", "release":
		return c.Button >= 0 && c.Button <= 2
	case "move", "wheel":
		return c.Button >= 0 && c.Button <= 3
	}
	return false
}
func mouseCode(code string) bool {
	switch code {
	case "TERMINAL_BAD_REQUEST", "TERMINAL_MOUSE_CONFLICT", "TERMINAL_MOUSE_SEQUENCE", "TERMINAL_MOUSE_MODE", "TERMINAL_MOUSE_GESTURE", "TERMINAL_BUSY", "TERMINAL_CLOSED":
		return true
	}
	return false
}
func validMouseState(m MouseState, end int64) bool {
	mode := m.Mode == -1 || m.Mode == 0 || mouseTracking(m.Mode)
	format := m.Format == -1 || m.Format == 0 || mouseEncoding(m.Format)
	phase := m.Phase == "idle" || m.Phase == "pending" || m.Phase == "held" || m.Phase == "expired" || m.Phase == "cancelled" || m.Phase == "mode-changed" || m.Phase == "closed"
	outcome := m.Outcome == "none" || m.Outcome == "queued" || m.Outcome == "written" || m.Outcome == "renewed" || m.Outcome == "cancelled" || m.Outcome == "expired" || m.Outcome == "mode-changed"
	return mode && format && phase && outcome && m.Buttons >= 0 && m.Buttons <= 7 && m.RemainingMs >= 0 && m.RemainingMs <= mouseLeaseMs && m.Epoch > 0 && m.Epoch <= MaxSequence && m.Offset >= 0 && m.Offset <= end && m.Gesture >= 0 && m.NextGesture > m.Gesture && m.NextGesture <= MaxSequence && m.AcceptedSequence >= 0 && m.AcceptedSequence <= MaxSequence && m.WrittenSequence >= 0 && m.WrittenSequence <= m.AcceptedSequence && (m.Phase != "closed" || m.Buttons == 0 && m.RemainingMs == 0)
}
func decodeMouseState(raw []byte) (*MouseState, error) {
	fields, err := objectFields(raw, 2048)
	var state MouseState
	if err != nil || !exactFields(fields, "mode,format,buttons,remainingMs,epoch,offset,gesture,nextGesture,acceptedSequence,writtenSequence,phase,outcome") || json.Unmarshal(raw, &state) != nil || !validMouseState(state, MaxSequence) {
		return nil, errProcessChannel
	}
	return &state, nil
}
func decodeMouseCommand(raw []byte) (*MouseCommand, error) {
	fields, err := objectFields(raw, 2048)
	var command MouseCommand
	if err != nil || !exactFields(fields, "action,sequence,epoch,gesture,column,row,button,modifiers") || json.Unmarshal(raw, &command) != nil || !validMouseCommand(command) {
		return nil, errProcessChannel
	}
	return &command, nil
}
