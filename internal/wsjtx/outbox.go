package wsjtx

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// OutboxItem is one QSO parked in the persistent retry queue.  It carries
// everything a sender needs to reconstruct the POST — including the
// endpoint so we can flush cookie-authenticated (/api/qsos) and
// token-authenticated (/api/wsjtx/qsos) QSOs from the same queue.  The
// auth headers themselves are NOT persisted: they live on the running
// session and are attached at send time.  This means a bridge restart
// with a fresh session still forwards a stale outbox correctly, and a
// leaked outbox file doesn't leak the operator's helper token.
type OutboxItem struct {
	ID       string    `json:"id"`
	QueuedAt time.Time `json:"queued_at"`
	// Endpoint is a URL path (starts with "/"); the sender prepends
	// the current server base.  Kept per-item so a mid-session mode
	// switch doesn't reroute already-queued QSOs.
	Endpoint string `json:"endpoint"`
	// Body is the pre-serialised JSON we would have POSTed.  It's
	// already been through validation/normalisation on the client side
	// (uppercased callsign, computed band, etc.) so retries produce the
	// same bytes the first attempt would have.
	Body json.RawMessage `json:"body"`

	// ContestID / Callsign / Mode / MyCall are convenience projections
	// for the UI (queue display, per-contest counts).  Duplicated with
	// the equivalent fields in Body so we don't have to re-parse JSON
	// on every widget refresh.
	ContestID int64  `json:"contest_id,omitempty"`
	Callsign  string `json:"callsign,omitempty"`
	Mode      string `json:"mode,omitempty"`
	MyCall    string `json:"my_call,omitempty"`

	// ForceDup mirrors the ?force=1 flag on the original submission.
	// Persisted so a retry after a service restart uses the same
	// duplicate policy the operator picked.
	ForceDup bool `json:"force_dup,omitempty"`

	// Attempts counts every send that hit the network — successful or
	// not.  LastError / LastAttempt let the UI show why an item is
	// still queued.  All three fields are updated in-place on retry.
	Attempts    int       `json:"attempts,omitempty"`
	LastError   string    `json:"last_error,omitempty"`
	LastAttempt time.Time `json:"last_attempt,omitempty"`
}

// SendResult tells the outbox how to treat the item after a send
// attempt.  The classification lives here (not at the HTTP layer) so
// the retry policy is one place — every caller uses the same rules.
type SendResult int

const (
	// SendOK: the server accepted the QSO.  Item is removed from the
	// outbox.
	SendOK SendResult = iota

	// SendRetry: transport failure or transient server error (5xx,
	// TLS handshake failure, DNS, connection refused).  Item stays in
	// the outbox and will be retried on the next tick.
	SendRetry

	// SendDrop: the server refused this QSO in a way that a retry
	// won't fix (401/403 auth, 409 duplicate without ForceDup, 422
	// callsign mismatch, 400 validation).  Item is removed and the
	// error is surfaced to the operator.
	SendDrop
)

// ErrOutboxCorrupt is returned by LoadOutbox when the on-disk file is
// present but unparseable.  A corrupt file is renamed with a timestamp
// suffix so it can be recovered manually; the returned outbox is empty.
var ErrOutboxCorrupt = errors.New("outbox file was corrupt; renamed with .corrupt suffix")

// Outbox is a durable QSO queue.  Every mutation writes to disk
// atomically so a crash or hard reboot preserves whatever the bridge
// had accepted from WSJT-X, even if it never made it to Noctalum.
type Outbox struct {
	path  string
	mu    sync.Mutex
	items []*OutboxItem
}

// LoadOutbox opens the on-disk queue at path.  A missing file yields an
// empty outbox — that's the normal "first run" case, not an error.  A
// corrupt file is renamed to path+".corrupt-<timestamp>" and the caller
// gets ErrOutboxCorrupt so they can surface a warning in the UI without
// losing the ability to keep running.
func LoadOutbox(path string) (*Outbox, error) {
	o := &Outbox{path: path}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return o, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return o, nil
	}
	if err := json.Unmarshal(data, &o.items); err != nil {
		suffix := ".corrupt-" + time.Now().UTC().Format("20060102150405")
		_ = os.Rename(path, path+suffix)
		o.items = nil
		return o, ErrOutboxCorrupt
	}
	return o, nil
}

// Add appends item and persists.  A missing ID is filled in; a missing
// QueuedAt gets stamped with now.  Returns after the disk write
// completes so a crash immediately after this call still has the item
// safely on disk.
func (o *Outbox) Add(item *OutboxItem) error {
	if item.ID == "" {
		item.ID = randOutboxID()
	}
	if item.QueuedAt.IsZero() {
		item.QueuedAt = time.Now().UTC()
	}
	o.mu.Lock()
	o.items = append(o.items, item)
	o.mu.Unlock()
	return o.save()
}

// Remove drops the item with the given ID.  Missing IDs are silently
// ignored so double-remove (e.g. successful send racing a stop) doesn't
// error.
func (o *Outbox) Remove(id string) error {
	o.mu.Lock()
	for i, it := range o.items {
		if it.ID == id {
			o.items = append(o.items[:i], o.items[i+1:]...)
			break
		}
	}
	o.mu.Unlock()
	return o.save()
}

// UpdateError records a failed attempt: bumps the counter, stashes the
// error string, stamps LastAttempt.  Persists on return.  A missing ID
// is a no-op — the item was probably removed by a concurrent success.
func (o *Outbox) UpdateError(id, msg string) error {
	o.mu.Lock()
	for _, it := range o.items {
		if it.ID == id {
			it.Attempts++
			it.LastError = msg
			it.LastAttempt = time.Now().UTC()
			break
		}
	}
	o.mu.Unlock()
	return o.save()
}

// Snapshot returns a deep copy of the current items, safe to iterate
// without holding the outbox lock.  Callers Flush against this snapshot
// so a slow send doesn't block Add.
func (o *Outbox) Snapshot() []OutboxItem {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]OutboxItem, len(o.items))
	for i, it := range o.items {
		out[i] = *it
	}
	return out
}

// Len returns the current queue length.  Cheap — used to drive the
// "N pending" label the GUI shows during an outage.
func (o *Outbox) Len() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.items)
}

// save writes the current items to disk atomically: write to a
// sibling temp file, fsync, rename over the target.  A crash mid-write
// therefore leaves either the previous good file or the new good file,
// never a truncated one.
func (o *Outbox) save() error {
	if o.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(o.path), 0700); err != nil {
		return err
	}
	o.mu.Lock()
	data, err := json.MarshalIndent(o.items, "", "  ")
	o.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := o.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, o.path)
}

func randOutboxID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// Shouldn't happen; fall back to a timestamp so we still get
		// a unique-ish ID rather than an empty string that would
		// collide across items.
		return time.Now().UTC().Format("20060102150405.000000")
	}
	return hex.EncodeToString(b)
}
