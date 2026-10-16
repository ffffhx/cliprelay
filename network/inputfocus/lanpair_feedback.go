package inputfocus

// Remote feedback never grants trust. The independent receipt selects one
// generation, and the TLS client certificate must still own that generation.
import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"time"
)

type pairFeedbackTicket struct {
	Protocol int    `json:"protocol"`
	Receipt  string `json:"receipt"`
}

type pairFeedbackStatus struct {
	Protocol int    `json:"protocol"`
	ID       string `json:"id"`
	Receipt  string `json:"receipt"`
	State    string `json:"state"`
	Expires  int64  `json:"expires"`
}

type pairFeedbackResult struct {
	status pairFeedbackStatus
	client [32]byte
	until  time.Time
}

func (p *lanPairer) pruneFeedbackLocked(now time.Time) {
	for receipt, result := range p.feedback {
		if !now.Before(result.until) {
			delete(p.feedback, receipt)
		}
	}
}

func (p *lanPairer) feedbackStateLocked(request *lanRequest, now time.Time) string {
	if request.finalState != "" && request.finalState != "handshake" {
		return request.finalState
	}
	if now.Unix() >= request.Expires {
		request.finalState = "expired"
		request.cancel()
		return "expired"
	}
	if request.finalState == "handshake" {
		return "handshake"
	}
	return request.decision
}

func (p *lanPairer) retainFeedbackLocked(request *lanRequest, reason error) {
	if request.Feedback == nil || p.closed {
		return
	}
	now := time.Now()
	state := p.feedbackStateLocked(request, now)
	if state == "waiting" || state == "approving" {
		state = "cancelled"
		if reason == context.DeadlineExceeded {
			state = "expired"
		}
	}
	p.pruneFeedbackLocked(now)
	if p.feedback == nil {
		p.feedback = make(map[string]pairFeedbackResult)
	}
	// Bound retained decisions independently of the eight active requests.
	if len(p.feedback) >= 128 {
		var oldest string
		for receipt, result := range p.feedback {
			if oldest == "" || result.until.Before(p.feedback[oldest].until) {
				oldest = receipt
			}
		}
		delete(p.feedback, oldest)
	}
	p.feedback[request.Feedback.Receipt] = pairFeedbackResult{
		status: pairFeedbackStatus{1, request.ID, request.Feedback.Receipt, state, request.Expires},
		client: sha256.Sum256(request.client), until: now.Add(2 * time.Minute),
	}
}

func (p *lanPairer) serveFeedback(w http.ResponseWriter, r *http.Request, certificate []byte) bool {
	if r.URL.Path != "/v1/pair/status" || r.Method != "POST" {
		return false
	}
	if !p.managed {
		http.NotFound(w, r)
		return true
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "JSON required", 415)
		return true
	}
	// Token parsing rejects duplicate keys as well as extra or non-string data.
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	fields := make(map[string]string)
	valid := true
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		valid = false
	} else {
		for d.More() && valid {
			token, err := d.Token()
			key, ok := token.(string)
			if err != nil || !ok || (key != "id" && key != "receipt") {
				valid = false
				break
			}
			if _, duplicate := fields[key]; duplicate {
				valid = false
				break
			}
			var value string
			if d.Decode(&value) != nil || !pairNonce.MatchString(value) {
				valid = false
				break
			}
			fields[key] = value
		}
		if token, err := d.Token(); err != nil || token != json.Delim('}') || d.Decode(new(any)) != io.EOF {
			valid = false
		}
	}
	if !valid || len(fields) != 2 {
		http.Error(w, "invalid request", 400)
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.ctx.Err() != nil {
		http.Error(w, "pairing stopping", 503)
		return true
	}
	now := time.Now()
	p.pruneFeedbackLocked(now)
	client := sha256.Sum256(certificate)
	var status pairFeedbackStatus
	request := p.requests[fields["id"]]
	if request != nil && request.Feedback != nil && request.Feedback.Receipt == fields["receipt"] && sha256.Sum256(request.client) == client {
		status = pairFeedbackStatus{1, request.ID, request.Feedback.Receipt, p.feedbackStateLocked(request, now), request.Expires}
	} else if result, exists := p.feedback[fields["receipt"]]; exists && result.status.ID == fields["id"] && result.client == client {
		status = result.status
		if status.State == "handshake" && now.Unix() >= status.Expires {
			status.State = "expired"
		}
	} else {
		http.Error(w, "unknown request", 404)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
	return true
}
