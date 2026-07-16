// Package backup implements Postgres backups for Noctalum: a native Go
// SQL dumper (no pg_dump binary required in the container), a Manager
// that writes gzipped dumps to a bind-mounted host directory with
// content-hash deduplication + age-based retention, and a daily
// scheduler goroutine.
//
// Restore path is deliberately kept out of this package. Per the design
// decision (option a), the admin UI offers download-only; an operator
// restores manually via `zcat noctalum-*.sql.gz | psql ...` on the host,
// with the app stopped. Keeping the "wipe and reload the live DB"
// button out of the app removes a category of catastrophic misclicks.
package backup

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// hashLen is the number of hex characters of sha256 we keep in the
// filename and use for dedup. 12 hex chars = 48 bits = ~2.8×10^14
// distinct values — birthday-collision negligible at Noctalum's scale.
const hashLen = 12

// Backup describes one .sql.gz file on disk.
type Backup struct {
	Name      string    `json:"name"`
	Path      string    `json:"-"`
	Bytes     int64     `json:"bytes"`
	CreatedAt time.Time `json:"created_at"`
	// Hash is a hashLen-hex-char prefix of sha256 of the dump body
	// (the leading preamble comment is excluded so identical data
	// produces identical hashes even when taken at different times).
	Hash string `json:"hash"`
	// Auto is true if this backup was created by the daily scheduler,
	// false if it was created via the manual "take backup" API.
	Auto bool `json:"auto"`
}

// Manager owns a backups directory. Concurrent Take() calls are
// serialised so two triggers can't race on the same tempfile name or
// dedup check.
type Manager struct {
	db  *sql.DB
	dir string
	mu  sync.Mutex
	// OnAudit, if non-nil, is invoked by RunScheduler() every time an
	// automatic take or a retention prune completes (success OR
	// failure). Server wires this to the audit-log store so scheduler-
	// driven activity is visible in the same place as operator-driven
	// activity. Callers that hit Take/Prune/Delete directly through
	// the HTTP handler audit those in their own layer — the callback
	// fires ONLY from the daily scheduler goroutine.
	//
	// action is the AuditBackup* constant. target is the backup
	// filename (empty for prune). details is a short human-readable
	// summary (byte count, hash, prune count, error message).
	OnAudit func(action, target, details string, isError bool)
}

// New creates a Manager writing into dir. dir is created (mode 0o755)
// if missing so first-boot on a fresh volume just works.
func New(db *sql.DB, dir string) (*Manager, error) {
	if dir == "" {
		return nil, errors.New("backup: dir must not be empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("backup: mkdir %s: %w", dir, err)
	}
	return &Manager{db: db, dir: dir}, nil
}

// Dir returns the on-disk directory this Manager writes to.
func (m *Manager) Dir() string { return m.dir }

// Take generates one backup. The dump body is hashed while being
// written; if an existing backup on disk carries the same hash prefix
// the new file is discarded and the existing Backup is returned
// instead (dedup). `auto` marks whether this call came from the daily
// scheduler; it's stored via a filename suffix so List() can surface
// it without a sidecar file.
func (m *Manager) Take(ctx context.Context, auto bool) (*Backup, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	tmp, err := os.CreateTemp(m.dir, ".backup-*.sql.gz.part")
	if err != nil {
		return nil, fmt.Errorf("backup: tempfile: %w", err)
	}
	tmpName := tmp.Name()
	// If we don't rename the temp file into place (dedup match or error),
	// Remove wipes it. If we do rename, Remove no-ops on the missing
	// source.
	defer func() { _ = os.Remove(tmpName) }()

	// Hash the *uncompressed* body so identical data hashes the same
	// regardless of gzip level, timestamp headers, etc.
	hasher := sha256.New()
	gz := gzip.NewWriter(tmp)
	body := io.MultiWriter(gz, hasher)

	if err := Dump(ctx, m.db, body); err != nil {
		_ = gz.Close()
		_ = tmp.Close()
		return nil, fmt.Errorf("backup: dump: %w", err)
	}
	if err := gz.Close(); err != nil {
		_ = tmp.Close()
		return nil, fmt.Errorf("backup: gzip flush: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return nil, fmt.Errorf("backup: close: %w", err)
	}

	fullHash := hex.EncodeToString(hasher.Sum(nil))
	shortHash := fullHash[:hashLen]

	// Dedup: cheap linear scan of the directory. At retention scales we
	// realistically talk about (weeks or months), this is a few dozen
	// entries at most.
	existing, err := m.List()
	if err != nil {
		return nil, err
	}
	for _, b := range existing {
		if b.Hash == shortHash {
			// Content matches — leave existing file alone, discard temp.
			return &b, nil
		}
	}

	now := time.Now().UTC()
	suffix := "manual"
	if auto {
		suffix = "auto"
	}
	fname := fmt.Sprintf("noctalum-%s-%s-%s.sql.gz",
		now.Format("20060102T150405Z"), shortHash, suffix)
	finalPath := filepath.Join(m.dir, fname)
	if err := os.Rename(tmpName, finalPath); err != nil {
		return nil, fmt.Errorf("backup: rename: %w", err)
	}
	info, err := os.Stat(finalPath)
	if err != nil {
		return nil, err
	}
	return &Backup{
		Name:      fname,
		Path:      finalPath,
		Bytes:     info.Size(),
		CreatedAt: now,
		Hash:      shortHash,
		Auto:      auto,
	}, nil
}

// List returns every recognised backup in the directory, newest-first.
// Files that don't match the noctalum-*.sql.gz naming pattern are
// silently ignored so an admin can drop `.txt` notes or leftover
// pg_dump output in the same directory without confusing the UI.
func (m *Manager) List() ([]Backup, error) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, fmt.Errorf("backup: readdir: %w", err)
	}
	var out []Backup
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		hash, when, auto, ok := parseFilename(name)
		if !ok {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Backup{
			Name:      name,
			Path:      filepath.Join(m.dir, name),
			Bytes:     info.Size(),
			CreatedAt: when,
			Hash:      hash,
			Auto:      auto,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

// Delete removes one backup by filename. Refuses paths containing a
// directory separator so callers can't traverse out of m.dir.
func (m *Manager) Delete(name string) error {
	if _, _, _, ok := parseFilename(name); !ok {
		return fmt.Errorf("backup: not a Noctalum backup filename: %q", name)
	}
	return os.Remove(filepath.Join(m.dir, name))
}

// Open returns a reader for one backup. Caller closes it.
func (m *Manager) Open(name string) (*os.File, error) {
	if _, _, _, ok := parseFilename(name); !ok {
		return nil, fmt.Errorf("backup: not a Noctalum backup filename: %q", name)
	}
	return os.Open(filepath.Join(m.dir, name))
}

// Prune deletes backups whose CreatedAt is older than `retention` ago.
// retention <= 0 keeps everything (used to disable pruning via the
// settings UI).
func (m *Manager) Prune(retention time.Duration) (int, error) {
	if retention <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-retention)
	entries, err := m.List()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, b := range entries {
		if b.CreatedAt.Before(cutoff) {
			if err := os.Remove(b.Path); err != nil {
				return n, fmt.Errorf("backup: prune %s: %w", b.Name, err)
			}
			n++
		}
	}
	return n, nil
}

// RunScheduler starts a goroutine that, every hour, checks whether the
// newest backup is older than 24 h and takes a fresh one if so, then
// prunes anything past the retention window. Cancel via ctx.
//
// retentionFn is a function so the caller can rebind the value at
// runtime without restarting the loop (the setting is editable in the
// Settings UI). Return <= 0 to disable pruning.
func (m *Manager) RunScheduler(ctx context.Context, retentionFn func() time.Duration) {
	// Hourly wake — small enough that if the app was down over midnight
	// we still catch up the same day, big enough not to waste cycles.
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	// One tick on start so a freshly-restored app takes its first
	// backup without waiting an hour.
	m.tick(ctx, retentionFn())
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tick(ctx, retentionFn())
		}
	}
}

func (m *Manager) tick(ctx context.Context, retention time.Duration) {
	backups, err := m.List()
	if err != nil {
		log.Printf("backup: list failed: %v", err)
		return
	}
	shouldTake := len(backups) == 0 || time.Since(backups[0].CreatedAt) >= 24*time.Hour
	if shouldTake {
		if b, err := m.Take(ctx, true); err != nil {
			log.Printf("backup: automatic take failed: %v", err)
			m.emit("backup.auto", "", "automatic take failed: "+err.Error(), true)
		} else {
			log.Printf("backup: automatic take succeeded (%s, %d bytes)", b.Name, b.Bytes)
			m.emit("backup.auto", b.Name,
				fmt.Sprintf("automatic daily backup, %d bytes, hash=%s", b.Bytes, b.Hash), false)
		}
	}
	if n, err := m.Prune(retention); err != nil {
		log.Printf("backup: prune failed: %v", err)
		m.emit("backup.prune", "",
			fmt.Sprintf("retention prune failed (retention=%s): %v", retention, err), true)
	} else if n > 0 {
		log.Printf("backup: pruned %d backup(s) older than %s", n, retention)
		m.emit("backup.prune", "",
			fmt.Sprintf("pruned %d backup(s) older than %s", n, retention), false)
	}
}

// emit forwards an event to OnAudit if configured. Kept nil-safe so
// unit tests and dev setups without a Server hookup don't panic.
func (m *Manager) emit(action, target, details string, isError bool) {
	if m.OnAudit != nil {
		m.OnAudit(action, target, details, isError)
	}
}

// parseFilename matches "noctalum-YYYYMMDDTHHMMSSZ-<12hex>-{auto|manual}.sql.gz"
// and returns (hash, createdAt, auto, ok). Anything that doesn't
// match cleanly is treated as "not our file" and skipped.
func parseFilename(name string) (hash string, when time.Time, auto bool, ok bool) {
	if !strings.HasPrefix(name, "noctalum-") || !strings.HasSuffix(name, ".sql.gz") {
		return "", time.Time{}, false, false
	}
	stripped := strings.TrimSuffix(strings.TrimPrefix(name, "noctalum-"), ".sql.gz")
	parts := strings.Split(stripped, "-")
	// parts: [YYYYMMDDTHHMMSSZ, <12hex>, {auto|manual}]
	if len(parts) != 3 {
		return "", time.Time{}, false, false
	}
	when, err := time.Parse("20060102T150405Z", parts[0])
	if err != nil {
		return "", time.Time{}, false, false
	}
	if len(parts[1]) != hashLen {
		return "", time.Time{}, false, false
	}
	// Validate hex
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return "", time.Time{}, false, false
	}
	switch parts[2] {
	case "auto":
		auto = true
	case "manual":
		auto = false
	default:
		return "", time.Time{}, false, false
	}
	return parts[1], when.UTC(), auto, true
}
