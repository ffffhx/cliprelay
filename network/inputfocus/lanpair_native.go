package inputfocus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// This public correlation ID is separate from the private approval generation
// and feedback receipt. It can admit a native waiter, never authorize a client.
type nativePairTicket struct {
	Protocol int    `json:"protocol"`
	ID       string `json:"id"`
}

const nativePairOperationTimeout = 3 * time.Second

func nativePairFingerprint(request *lanRequest) string {
	digest := sha256.Sum256(request.client)
	return hex.EncodeToString(digest[:])
}

func nativePairBody(request *lanRequest) map[string]string {
	return map[string]string{"id": request.Native.ID, "client_fingerprint": nativePairFingerprint(request)}
}

func (p *lanPairer) prepareNativePairing(parent context.Context, request *lanRequest) error {
	ctx, cancel := context.WithTimeout(parent, nativePairOperationTimeout)
	defer cancel()
	data, err := p.engine(ctx, "POST", "/api/cliprelay/pairing", nativePairBody(request))
	if err != nil {
		return err
	}
	var reply struct {
		Protocol int  `json:"protocol"`
		Status   bool `json:"status"`
	}
	if json.Unmarshal(data, &reply) != nil || reply.Protocol != 1 || !reply.Status {
		return errors.New("native pairing registration was not confirmed")
	}
	return nil
}

func (p *lanPairer) finishNativePairing(request *lanRequest) {
	// Request cancellation is why cleanup runs, so use a new, independently
	// bounded context. The native engine also expires these registrations.
	ctx, cancel := context.WithTimeout(context.Background(), nativePairOperationTimeout)
	defer cancel()
	// No mutation replay after a lost reply. Exact generation/certificate
	// binding prevents this cleanup from deleting a replacement or saved trust.
	_, _ = p.engine(ctx, "DELETE", "/api/cliprelay/pairing", nativePairBody(request))
}
