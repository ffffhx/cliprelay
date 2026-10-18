package inputfocus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newManagedPrivacyPolicyFixture(t *testing.T) (*privacyFixture, http.Handler) {
	f, h := newPrivacyFixture(t)
	f.control.managed = func(ctx context.Context, op string, q privacyRequest, owner string) (privacyResponse, error) {
		if q.Lease != "" && (owner != displayOwner([]byte("first")) || q.Instance != testDisplayInstance || q.Stream != 10) {
			t.Fatal("private binding lost or forged")
		}
		raw, _ := json.Marshal(map[string]string{"op": op, "lease": q.Lease})
		result, err := f.control.read("privacy:" + string(raw))
		var value privacyResponse
		if err == nil {
			err = json.Unmarshal(result, &value)
		}
		return value, err
	}
	return f, h
}

func TestPrivacyManagedPolicyRechecksBindingAndRemainingGrant(t *testing.T) {
	for _, cause := range []string{"revoked-during-final-read", "expired-during-final-read", "capture-changed-after-activation"} {
		t.Run(cause, func(t *testing.T) {
			f, h := newManagedPrivacyPolicyFixture(t)
			calls := 0
			f.control.provider = func(context.Context, bool, *displaySelection) (displayState, error) {
				calls++
				state := f.state
				if calls == 2 {
					switch cause {
					case "revoked-during-final-read":
						filePairing(t, f.control.clients, []byte("second"))
					case "expired-during-final-read":
						f.now = f.now.Add(16 * time.Second)
					case "capture-changed-after-activation":
						state.Phase = "starting"
					}
				}
				return state, nil
			}
			w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start"))
			if w.Code == 200 || f.active != "" || f.control.request.Lease != "" || f.stops != 1 {
				t.Fatal("final reply claimed stale authority", w.Code, w.Body.String())
			}
		})
	}
}

func TestPrivacyManagedForeignStatusCannotCancelOwnedRecovery(t *testing.T) {
	f, h := newManagedPrivacyPolicyFixture(t)
	if w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	f.control.managed = func(context.Context, string, privacyRequest, string) (privacyResponse, error) {
		t.Fatal("foreign polling entered owned broker")
		return privacyResponse{}, nil
	}
	w := fileCall(h, []byte("second"), "POST", "/v1/privacy", `{"op":"status"}`)
	if w.Code != 200 || strings.Contains(w.Body.String(), privacyTestLease) || strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatal("foreign state leaked", w.Body.String())
	}
}

func TestPrivacyManagedRestoreFailureIsRetriedAndNotReportedComplete(t *testing.T) {
	f, h := newManagedPrivacyPolicyFixture(t)
	if w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	original := f.control.managed
	fail := true
	f.control.managed = func(ctx context.Context, op string, q privacyRequest, owner string) (privacyResponse, error) {
		if op == "stop" && fail {
			return privacyResponse{}, errors.New("original process not reaped")
		}
		return original(ctx, op, q, owner)
	}
	w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("stop"))
	if w.Code != 503 || f.control.request.Lease == "" || f.active == "" {
		t.Fatal("unconfirmed stop reported success", w.Code, w.Body.String())
	}
	fail = false
	f.control.check(context.Background())
	if f.control.request.Lease != "" || f.active != "" || f.stops != 1 {
		t.Fatal("restoration was not retried")
	}
}

func TestPrivacyManagedDuplicatePublicKeysCannotStartWorker(t *testing.T) {
	f, h := newManagedPrivacyPolicyFixture(t)
	body := privacyBody("start")
	for _, bad := range []string{`{"op":"status",` + body[1:], `{"lease":"` + strings.Repeat("a", 32) + `",` + body[1:]} {
		if w := fileCall(h, []byte("first"), "POST", "/v1/privacy", bad); w.Code != 400 {
			t.Fatal("ambiguous request accepted", w.Code)
		}
	}
	if f.starts != 0 {
		t.Fatal("ambiguous request launched worker")
	}
}

func TestPrivacyMaintenanceProviderFailureKeepsFailClosedPolicy(t *testing.T) {
	for _, cause := range []struct {
		err    error
		reason string
	}{
		{fmt.Errorf("private-provider-detail: %w", context.DeadlineExceeded), "display-timeout"},
		{fmt.Errorf("private-provider-detail: %w", context.Canceled), "display-canceled"},
		{errors.New("private-provider-detail"), "display-unavailable"},
	} {
		t.Run(cause.reason, func(t *testing.T) {
			f, h := newManagedPrivacyPolicyFixture(t)
			if w := fileCall(h, []byte("first"), "POST", "/v1/privacy", privacyBody("start")); w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			deadline := f.control.deadline
			f.control.provider = func(context.Context, bool, *displaySelection) (displayState, error) {
				return displayState{}, cause.err
			}
			if reason := f.control.bindingFailure(context.Background(), f.control.request, f.control.owner); reason != cause.reason {
				t.Fatal("provider failure was not safely classified", reason)
			}
			f.control.check(context.Background())
			if f.active != "" || f.control.request.Lease != "" || f.stops != 1 || !f.now.Before(deadline) {
				t.Fatal("provider failure did not restore the unexpired owned mask")
			}
		})
	}
}
