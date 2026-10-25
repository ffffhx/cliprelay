package main

import (
	"errors"
	"reflect"
	"testing"
)

type fakePairingClient struct {
	calls []string
	err   error
}

func (f *fakePairingClient) Request(action, data string) (string, error) {
	f.calls = append(f.calls, action+":"+data)
	return "", f.err
}

func TestAutoApprovePairingsApprovesOnlyValidDeviceIDs(t *testing.T) {
	client := &fakePairingClient{}
	autoApprovePairings(client, []map[string]any{
		{"id": "0123456789abcdef01234567", "name": "phone"},
		{"id": "../escape"},
		{"name": "missing id"},
		{"id": "FEDCBA9876543210FEDCBA98"},
		{"id": "fedcba9876543210fedcba98"},
	})
	want := []string{
		`approve:{"id":"0123456789abcdef01234567"}`,
		`approve:{"id":"fedcba9876543210fedcba98"}`,
	}
	if !reflect.DeepEqual(client.calls, want) {
		t.Fatalf("approval calls = %#v, want %#v", client.calls, want)
	}
}

func TestAutoApprovePairingsIgnoresApprovalFailures(t *testing.T) {
	client := &fakePairingClient{err: errors.New("409: pairing request expired or already handled")}
	autoApprovePairings(client, []map[string]any{{"id": "0123456789abcdef01234567"}})
	autoApprovePairings(client, []map[string]any{{"id": "fedcba9876543210fedcba98"}})
	if len(client.calls) != 2 {
		t.Fatalf("expected both polls to attempt approval, got %#v", client.calls)
	}
}
