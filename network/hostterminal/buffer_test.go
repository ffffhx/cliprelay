package hostterminal

import (
	"bytes"
	"testing"
)

func TestOutputRingPreservesExactBytesAcrossWrapsAndOversizedChunks(t *testing.T) {
	buffer := NewBuffer()
	var history []byte
	for round, size := range []int{0, 17, OutputLimit - 3, 113, OutputLimit + 79, OutputLimit*2 + 1, ReadLimit + 5} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte((i*17 + round*23) % 251)
		}
		buffer.Append(data)
		history = append(history, data...)
		start, end := buffer.Bounds()
		wantStart := max(0, len(history)-OutputLimit)
		if start != int64(wantStart) || end != int64(len(history)) {
			t.Fatal("wrong ring bounds", start, end)
		}
		var got []byte
		offset := int64(0)
		for {
			piece, actual, gap, err := buffer.Read(offset)
			if err != nil || actual != max(start, offset) || gap != (actual != offset) || len(piece) > ReadLimit {
				t.Fatal("invalid ring page", actual, gap, err)
			}
			got = append(got, piece...)
			offset = actual + int64(len(piece))
			if offset == end {
				break
			}
			if len(piece) == 0 {
				t.Fatal("ring made no progress")
			}
		}
		if !bytes.Equal(got, history[wantStart:]) {
			t.Fatal("wrapped output bytes changed", round)
		}
	}
}
