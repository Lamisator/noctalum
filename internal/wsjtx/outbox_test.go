package wsjtx

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The queue MUST survive an in-flight process restart: Add on one
// Outbox instance, then re-open a fresh Outbox against the same file
// and check the item is there.  This is the whole point of the outbox.
func TestOutboxPersistsAcrossReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.json")

	o, err := LoadOutbox(path)
	if err != nil {
		t.Fatalf("initial load: %v", err)
	}
	if o.Len() != 0 {
		t.Fatalf("fresh outbox should be empty, got %d", o.Len())
	}
	if err := o.Add(&OutboxItem{
		Endpoint: "/api/wsjtx/qsos",
		Callsign: "DM2LAP",
		Body:     json.RawMessage(`{"callsign":"DM2LAP"}`),
	}); err != nil {
		t.Fatalf("add: %v", err)
	}
	if o.Len() != 1 {
		t.Fatalf("after add: got %d, want 1", o.Len())
	}

	// Reopen — simulates a process restart.
	o2, err := LoadOutbox(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if o2.Len() != 1 {
		t.Fatalf("reload: got %d, want 1", o2.Len())
	}
	items := o2.Snapshot()
	if items[0].Callsign != "DM2LAP" {
		t.Errorf("reload lost fields: %+v", items[0])
	}
	if items[0].ID == "" {
		t.Errorf("Add should have filled in an ID; got empty")
	}
	if items[0].QueuedAt.IsZero() {
		t.Errorf("Add should have stamped QueuedAt; got zero")
	}
}

// Remove is idempotent (missing IDs are silently ignored) so a
// race between "successful send removes item" and "stop tears down
// state" doesn't error the caller.
func TestOutboxRemoveIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.json")
	o, _ := LoadOutbox(path)
	_ = o.Add(&OutboxItem{Callsign: "A"})
	id := o.Snapshot()[0].ID

	if err := o.Remove(id); err != nil {
		t.Fatalf("first remove: %v", err)
	}
	if err := o.Remove(id); err != nil {
		t.Errorf("second remove should be no-op, got: %v", err)
	}
	if err := o.Remove("nonexistent"); err != nil {
		t.Errorf("unknown-id remove should be no-op, got: %v", err)
	}
	if o.Len() != 0 {
		t.Errorf("after remove: len=%d, want 0", o.Len())
	}
}

// UpdateError bumps Attempts, stashes the message, and stamps
// LastAttempt.  Persisted on return.
func TestOutboxUpdateError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.json")
	o, _ := LoadOutbox(path)
	_ = o.Add(&OutboxItem{Callsign: "A"})
	id := o.Snapshot()[0].ID

	if err := o.UpdateError(id, "network down"); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := o.UpdateError(id, "still down"); err != nil {
		t.Fatalf("update: %v", err)
	}
	// Reload from disk to prove the update is persistent.
	o2, _ := LoadOutbox(path)
	items := o2.Snapshot()
	if items[0].Attempts != 2 {
		t.Errorf("Attempts = %d, want 2", items[0].Attempts)
	}
	if items[0].LastError != "still down" {
		t.Errorf("LastError = %q, want %q", items[0].LastError, "still down")
	}
	if items[0].LastAttempt.IsZero() {
		t.Errorf("LastAttempt not stamped")
	}
}

// A corrupt on-disk file is renamed with a .corrupt-<ts> suffix and the
// outbox starts empty — the alternative would be losing the ability to
// run at all until the operator hand-cleans the file.
func TestOutboxRecoversFromCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.json")
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	o, err := LoadOutbox(path)
	if err != ErrOutboxCorrupt {
		t.Fatalf("load: want ErrOutboxCorrupt, got %v", err)
	}
	if o.Len() != 0 {
		t.Errorf("corrupt load should yield empty outbox, got len=%d", o.Len())
	}
	// The bad bytes should have been renamed aside for post-mortem.
	matches, _ := filepath.Glob(filepath.Join(dir, "outbox.json.corrupt-*"))
	if len(matches) != 1 {
		t.Errorf("want 1 .corrupt-* backup, got %d", len(matches))
	}
	// And the outbox should now be usable for new Adds.
	if err := o.Add(&OutboxItem{Callsign: "X"}); err != nil {
		t.Fatalf("add after corrupt: %v", err)
	}
	o2, _ := LoadOutbox(path)
	if o2.Len() != 1 {
		t.Errorf("reload after recovery: want 1, got %d", o2.Len())
	}
}
