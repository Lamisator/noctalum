package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// QSO represents one logged contact.
type QSO struct {
	ID          int64     `json:"id"`
	ContestID   int64     `json:"contest_id,omitempty"`
	Time        time.Time `json:"time"`
	Callsign    string    `json:"callsign"`
	Name        string    `json:"name"`
	Band        string    `json:"band"`
	FreqHz      int64     `json:"freq_hz"`
	Mode        string    `json:"mode"`
	RSTSent     string    `json:"rst_sent"`
	RSTReceived string    `json:"rst_received"`
	NrSent      int       `json:"nr_sent"`
	NrReceived  int       `json:"nr_received"`
	DOK         string    `json:"dok"`
	Locator     string    `json:"locator"`
	ITUZone     string    `json:"itu_zone"`
	CQZone      string    `json:"cq_zone"`
	Lighthouse  string    `json:"lighthouse"`
	Operator    string    `json:"operator"`
	StationCall string    `json:"station_call"`
	Notes       string    `json:"notes"`
	ContestName string    `json:"contest_name"`
}

// Settings holds global defaults; station/contest info lives in each Contest.
type Settings struct {
	DefaultMode string `json:"default_mode"`
	DefaultBand string `json:"default_band"`
	HelperToken string `json:"helper_token"`
	QRZUsername string `json:"qrz_username"`
	QRZPassword string `json:"qrz_password"`
}

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the SQLite database at path.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite serial writer; keep simple
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS qsos (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			time_utc TEXT NOT NULL,
			callsign TEXT NOT NULL,
			band TEXT NOT NULL,
			freq_hz INTEGER NOT NULL,
			mode TEXT NOT NULL,
			rst_sent TEXT NOT NULL,
			rst_received TEXT NOT NULL,
			locator TEXT NOT NULL DEFAULT '',
			itu_zone TEXT NOT NULL DEFAULT '',
			cq_zone TEXT NOT NULL DEFAULT '',
			lighthouse TEXT NOT NULL DEFAULT '',
			operator TEXT NOT NULL,
			station_call TEXT NOT NULL,
			notes TEXT NOT NULL DEFAULT '',
			contest_name TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_qsos_time ON qsos(time_utc DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_qsos_callsign ON qsos(callsign)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate %q: %w", q, err)
		}
	}
	if err := s.migrateUsers(); err != nil {
		return err
	}
	if err := s.migratePasskeys(); err != nil {
		return err
	}
	if err := s.migrateContests(); err != nil {
		return err
	}
	if err := s.migrateAudit(); err != nil {
		return err
	}
	for _, col := range [][2]string{
		{"nr_sent", "INTEGER NOT NULL DEFAULT 0"},
		{"nr_received", "INTEGER NOT NULL DEFAULT 0"},
		{"dok", "TEXT NOT NULL DEFAULT ''"},
		{"name", "TEXT NOT NULL DEFAULT ''"},
	} {
		if err := s.addColumnIfMissing("qsos", col[0], col[1]); err != nil {
			return fmt.Errorf("migrate qsos column %s: %w", col[0], err)
		}
	}
	return nil
}

// InsertQSO appends a new QSO and returns the assigned ID.
func (s *Store) InsertQSO(q *QSO) (int64, error) {
	if q.Time.IsZero() {
		q.Time = time.Now().UTC()
	} else {
		q.Time = q.Time.UTC()
	}
	res, err := s.db.Exec(
		`INSERT INTO qsos (time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, contest_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		q.Time.Format(time.RFC3339),
		strings.ToUpper(q.Callsign),
		q.Name,
		q.Band, q.FreqHz, q.Mode, q.RSTSent, q.RSTReceived,
		q.NrSent, q.NrReceived, strings.ToUpper(q.DOK),
		strings.ToUpper(q.Locator), q.ITUZone, q.CQZone, q.Lighthouse,
		strings.ToUpper(q.Operator), strings.ToUpper(q.StationCall), q.Notes, q.ContestName,
		q.ContestID,
	)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	q.ID = id
	return id, nil
}

// ListQSOs returns up to limit recent QSOs for the given contest (newest first).
func (s *Store) ListQSOs(contestID int64, limit int) ([]QSO, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.db.Query(
		`SELECT id, contest_id, time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name
		 FROM qsos WHERE contest_id = ? ORDER BY id DESC LIMIT ?`, contestID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]QSO, 0, 64)
	for rows.Next() {
		var q QSO
		var t string
		if err := rows.Scan(&q.ID, &q.ContestID, &t, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
			&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
			&q.Locator, &q.ITUZone, &q.CQZone,
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName); err != nil {
			return nil, err
		}
		q.Time, _ = time.Parse(time.RFC3339, t)
		out = append(out, q)
	}
	return out, rows.Err()
}

// AllQSOs returns the full log for a contest in chronological order for export.
func (s *Store) AllQSOs(contestID int64) ([]QSO, error) {
	rows, err := s.db.Query(
		`SELECT id, contest_id, time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name
		 FROM qsos WHERE contest_id = ? ORDER BY time_utc ASC, id ASC`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []QSO
	for rows.Next() {
		var q QSO
		var t string
		if err := rows.Scan(&q.ID, &q.ContestID, &t, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
			&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
			&q.Locator, &q.ITUZone, &q.CQZone,
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName); err != nil {
			return nil, err
		}
		q.Time, _ = time.Parse(time.RFC3339, t)
		out = append(out, q)
	}
	return out, rows.Err()
}

// FindDuplicate returns true if a QSO with the same callsign+band+mode exists
// within the given window for the specified contest.
func (s *Store) FindDuplicate(contestID int64, callsign, band, mode string, within time.Duration) (bool, error) {
	since := time.Now().UTC().Add(-within).Format(time.RFC3339)
	row := s.db.QueryRow(
		`SELECT 1 FROM qsos WHERE contest_id = ? AND callsign = ? AND band = ? AND mode = ? AND time_utc >= ? LIMIT 1`,
		contestID, strings.ToUpper(callsign), band, mode, since)
	var x int
	if err := row.Scan(&x); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// MaxNrSent returns the highest nr_sent value for a contest (0 if none).
func (s *Store) MaxNrSent(contestID int64) (int, error) {
	var max int
	err := s.db.QueryRow(`SELECT COALESCE(MAX(nr_sent), 0) FROM qsos WHERE contest_id = ?`, contestID).Scan(&max)
	return max, err
}

// DeleteQSO removes a QSO by id.
func (s *Store) DeleteQSO(id int64) error {
	_, err := s.db.Exec(`DELETE FROM qsos WHERE id = ?`, id)
	return err
}

// LoadSettings returns the persisted settings, falling back to defaults.
func (s *Store) LoadSettings() (Settings, error) {
	defaults := Settings{
		DefaultMode: "SSB",
		DefaultBand: "20m",
	}
	rows, err := s.db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return defaults, err
	}
	defer rows.Close()
	out := defaults
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return defaults, err
		}
		switch k {
		case "default_mode":
			out.DefaultMode = v
		case "default_band":
			out.DefaultBand = v
		case "helper_token":
			out.HelperToken = v
		case "qrz_username":
			out.QRZUsername = v
		case "qrz_password":
			out.QRZPassword = v
		}
	}
	return out, rows.Err()
}

// SaveSettings persists global defaults (mode, band).
func (s *Store) SaveSettings(set Settings) error {
	pairs := [][2]string{
		{"default_mode", set.DefaultMode},
		{"default_band", set.DefaultBand},
	}
	if set.HelperToken != "" {
		pairs = append(pairs, [2]string{"helper_token", set.HelperToken})
	}
	pairs = append(pairs, [2]string{"qrz_username", set.QRZUsername})
	if set.QRZPassword != "" {
		pairs = append(pairs, [2]string{"qrz_password", set.QRZPassword})
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range pairs {
		if _, err := tx.Exec(
			`INSERT INTO settings(key,value) VALUES(?,?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
			p[0], p[1]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetHelperToken explicitly stores the helper token (used at startup to
// seed an auto-generated token when none exists).
func (s *Store) SetHelperToken(tok string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings(key,value) VALUES('helper_token',?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value`, tok)
	return err
}
