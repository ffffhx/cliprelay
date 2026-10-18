//go:build darwin && cgo

package hostaudio

import (
	"os"
	"testing"
)

func TestNativePrivateTapLifecycle(t *testing.T) {
	if os.Getenv("CLIPRELAY_AUDIO_MUTE_NATIVE_TEST") != "1" {
		t.Skip("explicit disposable native audio acceptance only")
	}
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("GITHUB_REPOSITORY") != "ffffhx/cliprelay" {
		t.Fatal("not an owned disposable CI job")
	}
	output := nativeOutput{}
	before, err := output.Outputs()
	if err != nil || before < 1 {
		t.Fatal("native output inventory", before, err)
	}
	if output.Healthy() {
		t.Fatal("unexpected pre-existing tap")
	}
	t.Cleanup(func() {
		if err := output.Stop(); err != nil {
			t.Error(err)
		}
	})
	if err := output.Start(); err != nil {
		t.Fatal(err)
	}
	if !output.Healthy() {
		t.Fatal("private global muted tap not read back")
	}
	if err := output.Start(); err == nil {
		t.Fatal("second start replaced active native object")
	}
	if !output.Healthy() {
		t.Fatal("second start changed original native object")
	}
	if err := output.Stop(); err != nil {
		t.Fatal(err)
	}
	if output.Healthy() {
		t.Fatal("tap retained after confirmed destruction")
	}
	if err := output.Stop(); err != nil {
		t.Fatal("idempotent cleanup", err)
	}
	after, err := output.Outputs()
	if err != nil || before != after {
		t.Fatal("device inventory changed", before, after, err)
	}
}
