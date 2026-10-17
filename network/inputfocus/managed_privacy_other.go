//go:build !darwin

package inputfocus

import "context"

func configureManagedPrivacy(context.Context, *privacyControl, string, EngineAccess) (func(), error) {
	return func() {}, nil
}
