package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrStashNotFound is returned when a stash row does not exist or is owned by another user.
var ErrStashNotFound = errors.New("stash not found")

// Stash is a snapshot of an in-flight QSO entry that was discarded automatically
// when the TRX moved to a different frequency. The operator can later "recall" it
// from the Stash tab, which retunes the TRX and restores the form.
type Stash struct {
	ID          int64     `json:"id"`
	ContestID   int64     `json:"contest_id"`
	UserID      int64     `json:"user_id"`
	CreatedAt   time.Time `json:"created_at"`
	Callsign    string    `json:"callsign"`
	Name        string    `json:"name"`
	RSTSent     string    `json:"rst_sent"`
	RSTReceived string    `json:"rst_received"`
	NrReceived  int64     `json:"nr_received"`
	NrSent      int64     `json:"nr_sent"`
	Mode        string    `json:"mode"`
	Band        string    `json:"band"`
	FreqHz      int64     `json:"freq_hz"`
	DOK         string    `json:"dok"`
	Locator     string    `json:"locator"`
	ITUZone     string    `json:"itu_zone"`
	CQZone      string    `json:"cq_zone"`
	Notes       string    `json:"notes"`
	Lighthouse  string    `json:"lighthouse"`
	UTCTime     string    `json:"utc_time"`
	Extras      string    `json:"extras"`
}

func (s *Store) migrateStashes() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS qso_stashes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			contest_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			callsign TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			rst_sent TEXT NOT NULL DEFAULT '',
			rst_received TEXT NOT NULL DEFAULT '',
			nr_received INTEGER NOT NULL DEFAULT 0,
			nr_sent INTEGER NOT NULL DEFAULT 0,
			mode TEXT NOT NULL DEFAULT '',
			band TEXT NOT NULL DEFAULT '',
			freq_hz INTEGER NOT NULL DEFAULT 0,
			dok TEXT NOT NULL DEFAULT '',
			locator TEXT NOT NULL DEFAULT '',
			itu_zone TEXT NOT NULL DEFAULT '',
			cq_zone TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			lighthouse TEXT NOT NULL DEFAULT '',
			utc_time TEXT NOT NULL DEFAULT '',
			extras TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_qso_stashes_contest_user ON qso_stashes(contest_id, user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_qso_stashes_created_at ON qso_stashes(created_at)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate qso_stashes: %w", err)
		}
	}
	return nil
}

// CreateStash inserts a new stash and returns the populated row (with ID and created_at).
func (s *Store) CreateStash(in *Stash) (*Stash, error) {
	if in.CreatedAt.IsZero() {
		in.CreatedAt = time.Now().UTC()
	} else {
		in.CreatedAt = in.CreatedAt.UTC()
	}
	res, err := s.db.Exec(
		`INSERT INTO qso_stashes
			(contest_id, user_id, created_at, callsign, name, rst_sent, rst_received,
			 nr_received, nr_sent, mode, band, freq_hz, dok, locator, itu_zone, cq_zone,
			 notes, lighthouse, utc_time, extras)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		in.ContestID, in.UserID, in.CreatedAt.Format(time.RFC3339),
		in.Callsign, in.Name, in.RSTSent, in.RSTReceived,
		in.NrReceived, in.NrSent, in.Mode, in.Band, in.FreqHz,
		in.DOK, in.Locator, in.ITUZone, in.CQZone,
		in.Notes, in.Lighthouse, in.UTCTime, in.Extras,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	in.ID = id
	return in, nil
}

// ListStashes returns the user's stashes for the given contest, newest first.
func (s *Store) ListStashes(contestID, userID int64) ([]Stash, error) {
	rows, err := s.db.Query(
		`SELECT id, contest_id, user_id, created_at, callsign, name, rst_sent, rst_received,
		        nr_received, nr_sent, mode, band, freq_hz, dok, locator, itu_zone, cq_zone,
		        notes, lighthouse, utc_time, extras
		 FROM qso_stashes
		 WHERE contest_id = ? AND user_id = ?
		 ORDER BY created_at DESC, id DESC`,
		contestID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Stash
	for rows.Next() {
		var st Stash
		var createdAt string
		if err := rows.Scan(&st.ID, &st.ContestID, &st.UserID, &createdAt,
			&st.Callsign, &st.Name, &st.RSTSent, &st.RSTReceived,
			&st.NrReceived, &st.NrSent, &st.Mode, &st.Band, &st.FreqHz,
			&st.DOK, &st.Locator, &st.ITUZone, &st.CQZone,
			&st.Notes, &st.Lighthouse, &st.UTCTime, &st.Extras); err != nil {
			return nil, err
		}
		st.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		out = append(out, st)
	}
	return out, rows.Err()
}

// GetStash fetches a single stash if it is owned by the given user.
func (s *Store) GetStash(id, userID int64) (*Stash, error) {
	row := s.db.QueryRow(
		`SELECT id, contest_id, user_id, created_at, callsign, name, rst_sent, rst_received,
		        nr_received, nr_sent, mode, band, freq_hz, dok, locator, itu_zone, cq_zone,
		        notes, lighthouse, utc_time, extras
		 FROM qso_stashes WHERE id = ? AND user_id = ?`, id, userID)
	var st Stash
	var createdAt string
	if err := row.Scan(&st.ID, &st.ContestID, &st.UserID, &createdAt,
		&st.Callsign, &st.Name, &st.RSTSent, &st.RSTReceived,
		&st.NrReceived, &st.NrSent, &st.Mode, &st.Band, &st.FreqHz,
		&st.DOK, &st.Locator, &st.ITUZone, &st.CQZone,
		&st.Notes, &st.Lighthouse, &st.UTCTime, &st.Extras); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrStashNotFound
		}
		return nil, err
	}
	st.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &st, nil
}

// DeleteStash removes a stash; only the owning user may delete it.
// Returns ErrStashNotFound if no row matched.
func (s *Store) DeleteStash(id, userID int64) error {
	res, err := s.db.Exec(`DELETE FROM qso_stashes WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrStashNotFound
	}
	return nil
}

// PruneExpiredStashes deletes stashes for the given user+contest that are older
// than maxAge. Returns the deleted IDs so callers can broadcast WS events.
func (s *Store) PruneExpiredStashes(contestID, userID int64, maxAge time.Duration) ([]int64, error) {
	if maxAge <= 0 {
		return nil, nil
	}
	cutoff := time.Now().UTC().Add(-maxAge).Format(time.RFC3339)
	rows, err := s.db.Query(
		`SELECT id FROM qso_stashes WHERE contest_id = ? AND user_id = ? AND created_at < ?`,
		contestID, userID, cutoff)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	if _, err := s.db.Exec(
		`DELETE FROM qso_stashes WHERE contest_id = ? AND user_id = ? AND created_at < ?`,
		contestID, userID, cutoff); err != nil {
		return nil, err
	}
	return ids, nil
}
