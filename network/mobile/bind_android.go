//go:build android

package mobile

// Keep the exact binding runtime in go.mod for reproducible AAR generation.
import _ "golang.org/x/mobile/bind"
