package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"
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
	Extras      string    `json:"extras,omitempty"` // JSON-encoded custom-field values
}

// Settings holds global defaults; station/contest info lives in each Contest.
type Settings struct {
	DefaultMode           string `json:"default_mode"`
	DefaultBand           string `json:"default_band"`
	HelperToken           string `json:"helper_token"`
	QRZUsername           string `json:"qrz_username"`
	QRZPassword           string `json:"qrz_password"`
	ClusterCall           string `json:"cluster_call"`
	ClusterServer         string `json:"cluster_server"`
	ClusterRetentionDays  int    `json:"cluster_retention_days"`
	ChatSound             string `json:"chat_sound"` // "" | "beep" | "ding" | "chime"
	PublicFeatureRequests bool   `json:"public_feature_requests"`
}

// DummyRig is a simulated transceiver configuration persisted in the database.
type DummyRig struct {
	Name          string `json:"name"`
	DefaultFreqHz int64  `json:"default_freq_hz"`
}

// ClusterSpot is a single DX cluster spot stored in the database.
type ClusterSpot struct {
	ID        int64  `json:"id"`
	Time      string `json:"time"`
	DX        string `json:"dx"`
	Freq      string `json:"freq"`
	Band      string `json:"band"`
	Mode      string `json:"mode"`
	Comment   string `json:"comment"`
	Spotter   string `json:"spotter"`
	CreatedAt string `json:"created_at"`
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
		`CREATE TABLE IF NOT EXISTS cluster_spots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			time_str TEXT NOT NULL,
			dx TEXT NOT NULL,
			freq TEXT NOT NULL,
			band TEXT NOT NULL,
			mode TEXT NOT NULL,
			comment TEXT NOT NULL,
			spotter TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_cluster_spots_created ON cluster_spots(created_at DESC)`,
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
	if err := s.migrateSessions(); err != nil {
		return err
	}
	if err := s.migrateFeatureRequests(); err != nil {
		return err
	}
	if err := s.migrateChatMessages(); err != nil {
		return err
	}
	if err := s.migrateDummyRigs(); err != nil {
		return err
	}
	if err := s.migrateCallsignCache(); err != nil {
		return err
	}
	if err := s.migrateStashes(); err != nil {
		return err
	}
	if err := s.migrateShares(); err != nil {
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
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, contest_id, extras)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		q.Time.Format(time.RFC3339),
		strings.ToUpper(q.Callsign),
		q.Name,
		q.Band, q.FreqHz, q.Mode, q.RSTSent, q.RSTReceived,
		q.NrSent, q.NrReceived, strings.ToUpper(q.DOK),
		strings.ToUpper(q.Locator), q.ITUZone, q.CQZone, q.Lighthouse,
		strings.ToUpper(q.Operator), strings.ToUpper(q.StationCall), q.Notes, q.ContestName,
		q.ContestID, q.Extras,
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
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras
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
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras); err != nil {
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
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras
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
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras); err != nil {
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
func (s *Store) UpdateQSO(q *QSO) error {
	if q.Time.IsZero() {
		q.Time = time.Now().UTC()
	} else {
		q.Time = q.Time.UTC()
	}
	_, err := s.db.Exec(
		`UPDATE qsos SET time_utc=?, callsign=?, name=?, band=?, freq_hz=?, mode=?,
			rst_sent=?, rst_received=?, nr_sent=?, nr_received=?, dok=?,
			locator=?, itu_zone=?, cq_zone=?, lighthouse=?, notes=?, extras=?
		 WHERE id=?`,
		q.Time.Format(time.RFC3339),
		strings.ToUpper(q.Callsign), q.Name,
		q.Band, q.FreqHz, q.Mode, q.RSTSent, q.RSTReceived,
		q.NrSent, q.NrReceived, strings.ToUpper(q.DOK),
		strings.ToUpper(q.Locator), q.ITUZone, q.CQZone, q.Lighthouse, q.Notes, q.Extras,
		q.ID,
	)
	return err
}

func (s *Store) GetQSO(id int64) (*QSO, error) {
	row := s.db.QueryRow(
		`SELECT id, contest_id, time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras
		 FROM qsos WHERE id = ?`, id)
	var q QSO
	var ts string
	err := row.Scan(&q.ID, &q.ContestID, &ts, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
		&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
		&q.Locator, &q.ITUZone, &q.CQZone, &q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras)
	if err != nil {
		return nil, err
	}
	q.Time, _ = time.Parse(time.RFC3339, ts)
	return &q, nil
}

func (s *Store) DeleteQSO(id int64) error {
	_, err := s.db.Exec(`DELETE FROM qsos WHERE id = ?`, id)
	return err
}

// FeatureRequest is a user-submitted change request.
type FeatureRequest struct {
	ID           int64     `json:"id"`
	From         string    `json:"from"`
	Text         string    `json:"text"`
	Status       string    `json:"status"` // pending, accepted, declined, implemented
	AdminComment string    `json:"admin_comment"`
	CreatedAt    time.Time `json:"created_at"`
}

func (s *Store) migrateFeatureRequests() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS feature_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_user TEXT NOT NULL,
		text TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at TEXT NOT NULL
	)`)
	if err != nil {
		return err
	}
	return s.addColumnIfMissing("feature_requests", "admin_comment", "TEXT NOT NULL DEFAULT ''")
}

func (s *Store) InsertFeatureRequest(from, text string) (*FeatureRequest, error) {
	now := time.Now().UTC()
	res, err := s.db.Exec(
		`INSERT INTO feature_requests (from_user, text, status, admin_comment, created_at) VALUES (?, ?, 'pending', '', ?)`,
		from, text, now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &FeatureRequest{ID: id, From: from, Text: text, Status: "pending", CreatedAt: now}, nil
}

func (s *Store) scanFeatureRequest(rows interface {
	Scan(...any) error
}) (FeatureRequest, error) {
	var fr FeatureRequest
	var ts string
	if err := rows.Scan(&fr.ID, &fr.From, &fr.Text, &fr.Status, &fr.AdminComment, &ts); err != nil {
		return fr, err
	}
	fr.CreatedAt, _ = time.Parse(time.RFC3339, ts)
	return fr, nil
}

func (s *Store) ListFeatureRequests() ([]FeatureRequest, error) {
	rows, err := s.db.Query(
		`SELECT id, from_user, text, status, admin_comment, created_at FROM feature_requests ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FeatureRequest
	for rows.Next() {
		fr, err := s.scanFeatureRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, fr)
	}
	return out, rows.Err()
}

func (s *Store) ListFeatureRequestsByUser(username string) ([]FeatureRequest, error) {
	rows, err := s.db.Query(
		`SELECT id, from_user, text, status, admin_comment, created_at FROM feature_requests WHERE from_user=? ORDER BY id DESC`,
		username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FeatureRequest
	for rows.Next() {
		fr, err := s.scanFeatureRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, fr)
	}
	return out, rows.Err()
}

func (s *Store) UpdateFeatureRequestStatus(id int64, status string) error {
	_, err := s.db.Exec(`UPDATE feature_requests SET status=? WHERE id=?`, status, id)
	return err
}

func (s *Store) UpdateFeatureRequestComment(id int64, comment string) error {
	_, err := s.db.Exec(`UPDATE feature_requests SET admin_comment=? WHERE id=?`, comment, id)
	return err
}

func (s *Store) DeleteFeatureRequest(id int64) error {
	_, err := s.db.Exec(`DELETE FROM feature_requests WHERE id=?`, id)
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
		case "cluster_call":
			out.ClusterCall = v
		case "cluster_server":
			out.ClusterServer = v
		case "cluster_retention_days":
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				out.ClusterRetentionDays = n
			}
		case "chat_sound":
			out.ChatSound = v
		case "public_feature_requests":
			out.PublicFeatureRequests = v == "1" || v == "true"
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
	pairs = append(pairs, [2]string{"cluster_call", set.ClusterCall})
	pairs = append(pairs, [2]string{"cluster_server", set.ClusterServer})
	if set.ClusterRetentionDays > 0 {
		pairs = append(pairs, [2]string{"cluster_retention_days", strconv.Itoa(set.ClusterRetentionDays)})
	}
	pairs = append(pairs, [2]string{"chat_sound", set.ChatSound})
	publicFR := "0"
	if set.PublicFeatureRequests {
		publicFR = "1"
	}
	pairs = append(pairs, [2]string{"public_feature_requests", publicFR})
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

// ----- cluster spots -----

// SaveClusterSpot inserts a spot into the database.
func (s *Store) SaveClusterSpot(sp ClusterSpot) error {
	_, err := s.db.Exec(
		`INSERT INTO cluster_spots(time_str,dx,freq,band,mode,comment,spotter) VALUES(?,?,?,?,?,?,?)`,
		sp.Time, sp.DX, sp.Freq, sp.Band, sp.Mode, sp.Comment, sp.Spotter)
	return err
}

// LoadRecentClusterSpots returns the most recent limit spots ordered newest first.
func (s *Store) LoadRecentClusterSpots(limit int) ([]ClusterSpot, error) {
	rows, err := s.db.Query(
		`SELECT id,time_str,dx,freq,band,mode,comment,spotter,created_at
		 FROM cluster_spots ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClusterSpot
	for rows.Next() {
		var sp ClusterSpot
		if err := rows.Scan(&sp.ID, &sp.Time, &sp.DX, &sp.Freq, &sp.Band, &sp.Mode, &sp.Comment, &sp.Spotter, &sp.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// PruneClusterSpots deletes spots older than retentionDays days.
func (s *Store) PruneClusterSpots(retentionDays int) error {
	_, err := s.db.Exec(
		`DELETE FROM cluster_spots WHERE created_at < datetime('now', ? || ' days')`,
		strconv.Itoa(-retentionDays))
	return err
}

// ----- chat messages -----

// ChatMessage is a single persisted chat entry.
type ChatMessage struct {
	ContestID int64
	From      string
	User      string
	Text      string
	Time      time.Time
}

func (s *Store) migrateChatMessages() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS chat_messages (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		contest_id INTEGER NOT NULL,
		from_call  TEXT NOT NULL,
		username   TEXT NOT NULL,
		text       TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_contest ON chat_messages(contest_id, created_at)`)
	return err
}

// InsertChatMessage persists a chat message.
func (s *Store) InsertChatMessage(contestID int64, from, user, text, timeStr string) error {
	_, err := s.db.Exec(
		`INSERT INTO chat_messages (contest_id, from_call, username, text, created_at) VALUES (?, ?, ?, ?, ?)`,
		contestID, from, user, text, timeStr,
	)
	return err
}

// RecentChatMessages returns messages sent within the last 24 hours for the given contest, oldest first.
func (s *Store) RecentChatMessages(contestID int64) ([]ChatMessage, error) {
	cutoff := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	rows, err := s.db.Query(
		`SELECT from_call, username, text, created_at FROM chat_messages
		 WHERE contest_id = ? AND created_at > ? ORDER BY id ASC`,
		contestID, cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatMessage
	for rows.Next() {
		var m ChatMessage
		var ts string
		if err := rows.Scan(&m.From, &m.User, &m.Text, &ts); err != nil {
			return nil, err
		}
		m.Time, _ = time.Parse(time.RFC3339, ts)
		m.ContestID = contestID
		out = append(out, m)
	}
	return out, rows.Err()
}

// PruneChatMessages deletes messages older than 24 hours.
func (s *Store) PruneChatMessages() error {
	cutoff := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	_, err := s.db.Exec(`DELETE FROM chat_messages WHERE created_at <= ?`, cutoff)
	return err
}

// ----- dummy rigs -----

func (s *Store) migrateDummyRigs() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS dummy_rigs (
		name TEXT PRIMARY KEY,
		default_freq_hz INTEGER NOT NULL DEFAULT 14000000
	)`)
	return err
}

// ListDummyRigs returns all configured dummy TRXs.
func (s *Store) ListDummyRigs() ([]DummyRig, error) {
	rows, err := s.db.Query(`SELECT name, default_freq_hz FROM dummy_rigs ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DummyRig
	for rows.Next() {
		var d DummyRig
		if err := rows.Scan(&d.Name, &d.DefaultFreqHz); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// InsertDummyRig persists a new dummy TRX configuration.
func (s *Store) InsertDummyRig(name string, defaultFreqHz int64) error {
	_, err := s.db.Exec(
		`INSERT INTO dummy_rigs(name, default_freq_hz) VALUES(?, ?)`,
		name, defaultFreqHz)
	return err
}

// DeleteDummyRig removes a dummy TRX configuration.
func (s *Store) DeleteDummyRig(name string) error {
	_, err := s.db.Exec(`DELETE FROM dummy_rigs WHERE name = ?`, name)
	return err
}

// ----- callsign DOK cache -----

func (s *Store) migrateCallsignCache() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS callsign_cache (
		callsign TEXT PRIMARY KEY,
		dok TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	)`)
	return err
}

// UpsertCallsignDOK stores or updates the DOK for a callsign.
func (s *Store) UpsertCallsignDOK(callsign, dok string) error {
	_, err := s.db.Exec(
		`INSERT INTO callsign_cache(callsign, dok, updated_at) VALUES(?, ?, ?)
		 ON CONFLICT(callsign) DO UPDATE SET dok=excluded.dok, updated_at=excluded.updated_at`,
		strings.ToUpper(callsign), strings.ToUpper(dok), time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// GetCachedDOK returns the cached DOK for a callsign, or "" if not found.
func (s *Store) GetCachedDOK(callsign string) string {
	var dok string
	_ = s.db.QueryRow(`SELECT dok FROM callsign_cache WHERE callsign = ?`, strings.ToUpper(callsign)).Scan(&dok)
	return dok
}

// CallsignCacheEntry is one row of the callsign→DOK cache.
type CallsignCacheEntry struct {
	Callsign  string `json:"callsign"`
	DOK       string `json:"dok"`
	UpdatedAt string `json:"updated_at"`
}

// ListCallsignCache returns all entries ordered by callsign.
func (s *Store) ListCallsignCache() ([]CallsignCacheEntry, error) {
	rows, err := s.db.Query(`SELECT callsign, dok, updated_at FROM callsign_cache ORDER BY callsign`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CallsignCacheEntry
	for rows.Next() {
		var e CallsignCacheEntry
		if err := rows.Scan(&e.Callsign, &e.DOK, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteCallsignDOK removes a callsign entry from the cache.
func (s *Store) DeleteCallsignDOK(callsign string) error {
	_, err := s.db.Exec(`DELETE FROM callsign_cache WHERE callsign = ?`, strings.ToUpper(callsign))
	return err
}
