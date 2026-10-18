package hostterminal

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// MouseModes observes only host output, with the same bounded VT/UTF-8 parser
// as the Windows provider. Offsets count bytes, including split code points.
type MouseModes struct {
	Mode, Format             int
	Epoch, Offset, ChangedAt int64
	parser                   int
	osc, private             bool
	utf8Left, value, minimum int
	csi                      []byte
	saved                    map[int]bool
}

const (
	mouseGround = iota
	mouseEscape
	mouseEscapeIntermediate
	mouseCSI
	mouseCSIIgnore
	mouseString
)

func newMouseModes() MouseModes    { return MouseModes{Epoch: 1, saved: make(map[int]bool)} }
func mouseTracking(value int) bool { return value == 9 || value >= 1000 && value <= 1003 }
func mouseEncoding(value int) bool {
	return value == 1005 || value == 1006 || value == 1015 || value == 1016
}
func (m *MouseModes) Enabled() bool {
	return m.Mode == 9 || m.Mode == 1000 || m.Mode == 1002 || m.Mode == 1003
}
func (m *MouseModes) change(mode, format int, force bool) {
	if force || m.Mode != mode || m.Format != format {
		m.Mode, m.Format = mode, format
		m.Epoch++
		m.ChangedAt = m.Offset
	}
}
func (m *MouseModes) invalidateGrid() { m.change(m.Mode, m.Format, true) }
func (m *MouseModes) setPrivate(value int, enabled bool) {
	setting := 0
	if enabled {
		setting = value
	}
	if mouseTracking(value) {
		m.change(setting, m.Format, false)
	} else if mouseEncoding(value) {
		m.change(m.Mode, setting, false)
	}
}
func (m *MouseModes) dispatch(final int) {
	if len(m.csi) == 0 || m.csi[0] != '?' || final != 'h' && final != 'l' && final != 's' && final != 'r' {
		return
	}
	fields := strings.Split(string(m.csi[1:]), ";")
	invalid := func() {
		if final != 's' {
			m.change(-1, -1, true)
		}
	}
	if len(fields) > 32 {
		invalid()
		return
	}
	numbers := make([]int, len(fields))
	for i, field := range fields {
		if len(field) > 5 {
			invalid()
			return
		}
		for _, c := range field {
			if c < '0' || c > '9' {
				invalid()
				return
			}
		}
		if field != "" {
			numbers[i], _ = strconv.Atoi(field)
		}
	}
	for _, value := range numbers {
		if !mouseTracking(value) && !mouseEncoding(value) {
			continue
		}
		switch final {
		case 's':
			m.saved[value] = mouseTracking(value) && m.Mode == value || mouseEncoding(value) && m.Format == value
		case 'r':
			if enabled, ok := m.saved[value]; ok {
				m.setPrivate(value, enabled)
			}
		default:
			m.setPrivate(value, final == 'h')
		}
	}
}
func (m *MouseModes) character(value int) {
	switch value {
	case 0x18, 0x1a:
		m.parser, m.csi = mouseGround, m.csi[:0]
		return
	case 27:
		m.parser, m.csi = mouseEscape, m.csi[:0]
		return
	case 0x9b:
		m.parser, m.csi, m.private = mouseCSI, m.csi[:0], false
		return
	case 0x90, 0x98, 0x9d, 0x9e, 0x9f:
		m.osc, m.parser = value == 0x9d, mouseString
		return
	case 0x9c:
		m.parser, m.csi = mouseGround, m.csi[:0]
		return
	}
	if m.parser == mouseString {
		if m.osc && value == 7 {
			m.parser = mouseGround
		}
		return
	}
	if value < 32 || value == 127 {
		return
	}
	if value >= 128 {
		m.parser, m.csi = mouseGround, m.csi[:0]
		return
	}
	switch m.parser {
	case mouseGround:
		return
	case mouseEscape:
		switch {
		case value == '[':
			m.parser, m.private = mouseCSI, false
		case value == ']' || value == 'P' || value == 'X' || value == '^' || value == '_':
			m.osc, m.parser = value == ']', mouseString
		case value >= 0x20 && value <= 0x2f:
			m.parser = mouseEscapeIntermediate
		default:
			if value == 'c' {
				m.change(0, 0, true)
				clear(m.saved)
			}
			m.parser = mouseGround
		}
		return
	case mouseEscapeIntermediate:
		if value >= 0x30 && value <= 0x7e {
			m.parser = mouseGround
		}
		return
	}
	if value >= 0x40 && value <= 0x7e {
		if m.parser == mouseCSI {
			m.dispatch(value)
		} else if m.private && (value == 'h' || value == 'l' || value == 'r') {
			m.change(-1, -1, true)
		}
		m.csi, m.parser = m.csi[:0], mouseGround
	} else if m.parser == mouseCSI {
		if len(m.csi) == 0 {
			m.private = value == '?'
		}
		if len(m.csi) >= 256 {
			m.csi, m.parser = m.csi[:0], mouseCSIIgnore
		} else {
			m.csi = append(m.csi, byte(value))
		}
	}
}
func (m *MouseModes) Feed(data []byte) {
	for _, b := range data {
		m.Offset++
		if m.utf8Left > 0 {
			if b >= 0x80 && b <= 0xbf {
				m.value = m.value<<6 | int(b&63)
				m.utf8Left--
				if m.utf8Left == 0 {
					value := m.value
					if value < m.minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff {
						value = 0xfffd
					}
					m.character(value)
				}
				continue
			}
			m.utf8Left = 0
			m.character(0xfffd)
		}
		switch {
		case b < 0x80:
			m.character(int(b))
		case b >= 0xc2 && b <= 0xdf:
			m.utf8Left, m.value, m.minimum = 1, int(b&31), 0x80
		case b >= 0xe0 && b <= 0xef:
			m.utf8Left, m.value, m.minimum = 2, int(b&15), 0x800
		case b >= 0xf0 && b <= 0xf4:
			m.utf8Left, m.value, m.minimum = 3, int(b&7), 0x10000
		default:
			m.character(0xfffd)
		}
	}
}

func encodeMouse(mode, format int, action string, button, modifiers, column, row int) ([]byte, error) {
	bad, unsupported := errors.New("TERMINAL_BAD_REQUEST"), errors.New("TERMINAL_MOUSE_MODE")
	if !(mode == 9 || mode == 1000 || mode == 1002 || mode == 1003) || modifiers < 0 || modifiers > 28 || modifiers%4 != 0 {
		return nil, unsupported
	}
	if column < 1 || row < 1 || column > 65535 || row > 65535 {
		return nil, bad
	}
	code := button + modifiers
	release := action == "release"
	switch action {
	case "press", "release":
		if button < 0 || button > 2 {
			return nil, bad
		}
	case "move":
		if button < 0 || button > 3 || !(mode == 1003 || mode == 1002 && button != 3) {
			return nil, unsupported
		}
		code += 32
	case "wheel":
		if button < 0 || button > 3 || mode == 9 {
			return nil, unsupported
		}
		code += 64
	default:
		return nil, bad
	}
	if mode == 9 {
		if action != "press" {
			return nil, unsupported
		}
		code = button
	}
	if format == 1006 || format == 1016 {
		final := 'M'
		if release {
			final = 'm'
		}
		return []byte(fmt.Sprintf("\x1b[<%d;%d;%d%c", code, column, row, final)), nil
	}
	if release {
		code = 3 + modifiers
	}
	if format == 1015 {
		return []byte(fmt.Sprintf("\x1b[%d;%d;%dM", code+32, column, row)), nil
	}
	if format != 0 && format != 1005 {
		return nil, unsupported
	}
	limit := 223
	if format == 1005 {
		limit = 2015
	}
	if column > limit || row > limit {
		return nil, bad
	}
	if format == 1005 {
		return []byte("\x1b[M" + string([]rune{rune(code + 32), rune(column + 32), rune(row + 32)})), nil
	}
	return []byte{27, 91, 77, byte(code + 32), byte(column + 32), byte(row + 32)}, nil
}
