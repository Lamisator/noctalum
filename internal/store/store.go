package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
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
	// OperatorUserID identifies the account that logged this QSO. Used by
	// the per-contest permission model to decide whether a "logger"-role
	// participant may edit/delete this row (they can, if it's their own).
	// 0 for QSOs logged before the column was introduced; those pre-
	// existing rows are only editable by editors/owners.
	OperatorUserID int64 `json:"operator_user_id,omitempty"`
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
	// BackupRetentionDays controls how many days of DB backups the
	// scheduler keeps in /backups. 0 disables pruning (keep forever).
	// Default: 30.
	BackupRetentionDays int `json:"backup_retention_days"`
}

// DummyRig is a simulated transceiver configuration persisted in the database.
type DummyRig struct {
	Name          string `json:"name"`
	DefaultFreqHz int64  `json:"default_freq_hz"`
}

// ClusterSpot is a single DX cluster spot stored in the database.
// Time / CreatedAt are exchanged with the outside world as pre-formatted
// strings so the wire format matches what the DX-cluster protocol and
// existing frontend expect. Storage moved to TIMESTAMPTZ under the hood.
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

// Store wraps the PostgreSQL database handle. The pool defaults come from
// database/sql; we override them in Open() based on typical Postgres sizing
// rather than the previous SQLite single-writer serialisation.
type Store struct {
	db *sql.DB
}

// Open connects to Postgres using the given libpq/DSN or postgres:// URL
// (e.g. "postgres://user:pass@host:5432/dbname?sslmode=disable") and runs
// all migrations. Callers close the store with (*Store).Close().
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	// Postgres handles concurrent readers + writers natively; the previous
	// SetMaxOpenConns(1) cap was a SQLite-serialisation workaround. Cap at
	// 25 so a runaway request storm can't exhaust the server's
	// max_connections (default 100 minus reserved slots for admin +
	// replication).
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// DB exposes the underlying *sql.DB for callers (currently:
// internal/backup) that need to run schema-agnostic queries against
// pg_catalog / information_schema. Anything using the typed store API
// should keep going through the exported methods above.
func (s *Store) DB() *sql.DB { return s.db }

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS qsos (
			id            BIGSERIAL PRIMARY KEY,
			contest_id    BIGINT,
			time_utc      TIMESTAMPTZ NOT NULL,
			callsign      TEXT NOT NULL,
			name          TEXT NOT NULL DEFAULT '',
			band          TEXT NOT NULL,
			freq_hz       BIGINT NOT NULL,
			mode          TEXT NOT NULL,
			rst_sent      TEXT NOT NULL,
			rst_received  TEXT NOT NULL,
			nr_sent       INTEGER NOT NULL DEFAULT 0,
			nr_received   INTEGER NOT NULL DEFAULT 0,
			dok           TEXT NOT NULL DEFAULT '',
			locator       TEXT NOT NULL DEFAULT '',
			itu_zone      TEXT NOT NULL DEFAULT '',
			cq_zone       TEXT NOT NULL DEFAULT '',
			lighthouse    TEXT NOT NULL DEFAULT '',
			operator      TEXT NOT NULL,
			station_call  TEXT NOT NULL,
			notes         TEXT NOT NULL DEFAULT '',
			contest_name  TEXT NOT NULL DEFAULT '',
			extras        TEXT NOT NULL DEFAULT ''
		)`,
		// operator_user_id records which account logged the QSO. Added
		// for the per-contest permission model so "logger"-role
		// participants can only edit/delete their own rows. Pre-existing
		// rows default to 0 (owned by no one, editable only by
		// editors/owners of the contest).
		`ALTER TABLE qsos ADD COLUMN IF NOT EXISTS operator_user_id BIGINT NOT NULL DEFAULT 0`,
		`CREATE INDEX IF NOT EXISTS idx_qsos_time ON qsos(time_utc DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_qsos_callsign ON qsos(callsign)`,
		`CREATE INDEX IF NOT EXISTS idx_qsos_contest ON qsos(contest_id)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS cluster_spots (
			id         BIGSERIAL PRIMARY KEY,
			time_str   TEXT NOT NULL,
			dx         TEXT NOT NULL,
			freq       TEXT NOT NULL,
			band       TEXT NOT NULL,
			mode       TEXT NOT NULL,
			comment    TEXT NOT NULL,
			spotter    TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
	if err := s.migrateCallsignRequests(); err != nil {
		return err
	}
	if err := s.migrateLoginRequests(); err != nil {
		return err
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
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO qsos (time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, contest_id, extras, operator_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
		 RETURNING id`,
		q.Time,
		strings.ToUpper(q.Callsign),
		q.Name,
		q.Band, q.FreqHz, q.Mode, q.RSTSent, q.RSTReceived,
		q.NrSent, q.NrReceived, strings.ToUpper(q.DOK),
		strings.ToUpper(q.Locator), q.ITUZone, q.CQZone, q.Lighthouse,
		strings.ToUpper(q.Operator), strings.ToUpper(q.StationCall), q.Notes, q.ContestName,
		q.ContestID, q.Extras, q.OperatorUserID,
	).Scan(&id)
	if err != nil {
		return 0, err
	}
	q.ID = id
	return id, nil
}

// ListQSOs returns up to limit recent QSOs for the given contest (newest first).
func (s *Store) ListQSOs(contestID int64, limit int) ([]QSO, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.db.Query(
		`SELECT id, COALESCE(contest_id, 0), time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras, operator_user_id
		 FROM qsos WHERE contest_id = $1 ORDER BY id DESC LIMIT $2`, contestID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]QSO, 0, 64)
	for rows.Next() {
		var q QSO
		if err := rows.Scan(&q.ID, &q.ContestID, &q.Time, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
			&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
			&q.Locator, &q.ITUZone, &q.CQZone,
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras, &q.OperatorUserID); err != nil {
			return nil, err
		}
		q.Time = q.Time.UTC()
		out = append(out, q)
	}
	return out, rows.Err()
}

// AllQSOs returns the full log for a contest in chronological order for export.
func (s *Store) AllQSOs(contestID int64) ([]QSO, error) {
	rows, err := s.db.Query(
		`SELECT id, COALESCE(contest_id, 0), time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras, operator_user_id
		 FROM qsos WHERE contest_id = $1 ORDER BY time_utc ASC, id ASC`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []QSO
	for rows.Next() {
		var q QSO
		if err := rows.Scan(&q.ID, &q.ContestID, &q.Time, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
			&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
			&q.Locator, &q.ITUZone, &q.CQZone,
			&q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras, &q.OperatorUserID); err != nil {
			return nil, err
		}
		q.Time = q.Time.UTC()
		out = append(out, q)
	}
	return out, rows.Err()
}

// FindDuplicate returns true if a QSO with the same callsign+band+mode exists
// within the given window for the specified contest.
func (s *Store) FindDuplicate(contestID int64, callsign, band, mode string, within time.Duration) (bool, error) {
	since := time.Now().UTC().Add(-within)
	row := s.db.QueryRow(
		`SELECT 1 FROM qsos WHERE contest_id = $1 AND callsign = $2 AND band = $3 AND mode = $4 AND time_utc >= $5 LIMIT 1`,
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
	err := s.db.QueryRow(`SELECT COALESCE(MAX(nr_sent), 0) FROM qsos WHERE contest_id = $1`, contestID).Scan(&max)
	return max, err
}

// UpdateQSO writes an edited QSO row back to the database.
func (s *Store) UpdateQSO(q *QSO) error {
	if q.Time.IsZero() {
		q.Time = time.Now().UTC()
	} else {
		q.Time = q.Time.UTC()
	}
	_, err := s.db.Exec(
		`UPDATE qsos SET time_utc=$1, callsign=$2, name=$3, band=$4, freq_hz=$5, mode=$6,
			rst_sent=$7, rst_received=$8, nr_sent=$9, nr_received=$10, dok=$11,
			locator=$12, itu_zone=$13, cq_zone=$14, lighthouse=$15, notes=$16, extras=$17
		 WHERE id=$18`,
		q.Time,
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
		`SELECT id, COALESCE(contest_id, 0), time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			nr_sent, nr_received, dok,
			locator, itu_zone, cq_zone, lighthouse, operator, station_call, notes, contest_name, extras, operator_user_id
		 FROM qsos WHERE id = $1`, id)
	var q QSO
	err := row.Scan(&q.ID, &q.ContestID, &q.Time, &q.Callsign, &q.Name, &q.Band, &q.FreqHz, &q.Mode,
		&q.RSTSent, &q.RSTReceived, &q.NrSent, &q.NrReceived, &q.DOK,
		&q.Locator, &q.ITUZone, &q.CQZone, &q.Lighthouse, &q.Operator, &q.StationCall, &q.Notes, &q.ContestName, &q.Extras, &q.OperatorUserID)
	if err != nil {
		return nil, err
	}
	q.Time = q.Time.UTC()
	return &q, nil
}

func (s *Store) DeleteQSO(id int64) error {
	_, err := s.db.Exec(`DELETE FROM qsos WHERE id = $1`, id)
	return err
}

// FeatureRequest is a user-submitted change request. Zero or more file
// attachments live in the separate feature_request_attachments table and
// are populated by the store's list/get helpers so the UI has everything
// it needs in one JSON payload.
type FeatureRequest struct {
	ID           int64                      `json:"id"`
	From         string                     `json:"from"`
	Text         string                     `json:"text"`
	Status       string                     `json:"status"` // pending, accepted, declined, implemented
	AdminComment string                     `json:"admin_comment"`
	CreatedAt    time.Time                  `json:"created_at"`
	Attachments  []FeatureRequestAttachment `json:"attachments,omitempty"`
}

// FeatureRequestAttachment is one uploaded file attached to a feature
// request. The opaque on-disk token in Filename is never exposed via the
// API (json:"-") — clients download by attachment ID via the
// /api/feature-requests/{id}/attachments/{aid} route, which resolves the
// filename server-side.
type FeatureRequestAttachment struct {
	ID           int64     `json:"id"`
	Filename     string    `json:"-"`
	OriginalName string    `json:"original_name"`
	Mime         string    `json:"mime"`
	Size         int64     `json:"size"`
	CreatedAt    time.Time `json:"created_at"`
}

func (s *Store) migrateFeatureRequests() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS feature_requests (
		id            BIGSERIAL PRIMARY KEY,
		from_user     TEXT NOT NULL,
		text          TEXT NOT NULL,
		status        TEXT NOT NULL DEFAULT 'pending',
		admin_comment TEXT NOT NULL DEFAULT '',
		created_at    TIMESTAMPTZ NOT NULL
	)`); err != nil {
		return err
	}
	// Legacy single-attachment columns (superseded by the
	// feature_request_attachments table below). We still create them
	// on fresh installs so the backfill statements are portable across
	// old and new deployments, and so a rollback to a previous binary
	// doesn't crash on a missing column.
	for _, stmt := range []string{
		`ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS attachment_filename      TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS attachment_mime          TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS attachment_size          BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS attachment_original_name TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := s.db.Exec(stmt); err != nil {
			return err
		}
	}
	// Attachments live in their own table so a feature request can carry
	// zero, one, or many files. ON DELETE CASCADE removes the metadata
	// rows automatically when the parent request is deleted; the on-disk
	// files still need explicit cleanup at the server layer before the
	// DELETE runs (via ListFeatureRequestAttachments).
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS feature_request_attachments (
		id                 BIGSERIAL PRIMARY KEY,
		feature_request_id BIGINT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
		filename           TEXT NOT NULL,
		original_name      TEXT NOT NULL DEFAULT '',
		mime               TEXT NOT NULL DEFAULT '',
		size               BIGINT NOT NULL DEFAULT 0,
		created_at         TIMESTAMPTZ NOT NULL
	)`); err != nil {
		return err
	}
	if _, err := s.db.Exec(
		`CREATE INDEX IF NOT EXISTS idx_fr_attachments_fr ON feature_request_attachments(feature_request_id)`,
	); err != nil {
		return err
	}
	// Idempotent one-time backfill: copy the single-attachment metadata
	// from feature_requests into the new attachments table for any row
	// that hasn't been backfilled yet, then clear the legacy columns so
	// subsequent boots and subsequent user-driven deletes don't
	// resurrect the row. The WHERE EXISTS check on the UPDATE guards
	// against clearing a row whose INSERT hadn't completed (would only
	// happen on a partial migration; safe here since both statements
	// run back-to-back).
	if _, err := s.db.Exec(`
		INSERT INTO feature_request_attachments
			(feature_request_id, filename, original_name, mime, size, created_at)
		SELECT id, attachment_filename, attachment_original_name, attachment_mime, attachment_size, created_at
		FROM feature_requests
		WHERE attachment_filename <> ''
		  AND NOT EXISTS (
			SELECT 1 FROM feature_request_attachments a
			WHERE a.feature_request_id = feature_requests.id
			  AND a.filename = feature_requests.attachment_filename
		  )
	`); err != nil {
		return err
	}
	if _, err := s.db.Exec(`
		UPDATE feature_requests
		SET attachment_filename = '',
		    attachment_mime = '',
		    attachment_size = 0,
		    attachment_original_name = ''
		WHERE attachment_filename <> ''
		  AND EXISTS (
			SELECT 1 FROM feature_request_attachments a
			WHERE a.feature_request_id = feature_requests.id
			  AND a.filename = feature_requests.attachment_filename
		  )
	`); err != nil {
		return err
	}
	return nil
}

// InsertFeatureRequest stores a new text-only request. Attachments are
// recorded separately via InsertFeatureRequestAttachment against the
// returned ID.
func (s *Store) InsertFeatureRequest(from, text string) (*FeatureRequest, error) {
	now := time.Now().UTC()
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO feature_requests (from_user, text, status, admin_comment, created_at)
		 VALUES ($1, $2, 'pending', '', $3) RETURNING id`,
		from, text, now,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &FeatureRequest{
		ID: id, From: from, Text: text, Status: "pending", CreatedAt: now,
	}, nil
}

// InsertFeatureRequestAttachment records one uploaded file against an
// existing feature request. filename is the opaque on-disk token;
// originalName is the sanitized label to show in the UI.
func (s *Store) InsertFeatureRequestAttachment(frID int64, filename, originalName, mime string, size int64) (*FeatureRequestAttachment, error) {
	now := time.Now().UTC()
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO feature_request_attachments
			(feature_request_id, filename, original_name, mime, size, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		frID, filename, originalName, mime, size, now,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &FeatureRequestAttachment{
		ID: id, Filename: filename, OriginalName: originalName,
		Mime: mime, Size: size, CreatedAt: now,
	}, nil
}

// GetFeatureRequestAttachment fetches a single attachment (used by the
// download endpoint). Returns ErrNotFound when either the attachment or
// its parent request no longer exist.
func (s *Store) GetFeatureRequestAttachment(frID, attachmentID int64) (*FeatureRequestAttachment, error) {
	row := s.db.QueryRow(
		`SELECT id, filename, original_name, mime, size, created_at
		 FROM feature_request_attachments
		 WHERE id=$1 AND feature_request_id=$2`,
		attachmentID, frID)
	var a FeatureRequestAttachment
	err := row.Scan(&a.ID, &a.Filename, &a.OriginalName, &a.Mime, &a.Size, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.CreatedAt = a.CreatedAt.UTC()
	return &a, nil
}

// ListFeatureRequestAttachments returns all attachments for one feature
// request in insert order. Used by the DELETE handler so on-disk files
// can be cleaned up before the parent row goes away (CASCADE removes the
// metadata rows, but the filesystem doesn't get notified).
func (s *Store) ListFeatureRequestAttachments(frID int64) ([]FeatureRequestAttachment, error) {
	rows, err := s.db.Query(
		`SELECT id, filename, original_name, mime, size, created_at
		 FROM feature_request_attachments
		 WHERE feature_request_id=$1
		 ORDER BY id`, frID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FeatureRequestAttachment
	for rows.Next() {
		var a FeatureRequestAttachment
		if err := rows.Scan(&a.ID, &a.Filename, &a.OriginalName, &a.Mime, &a.Size, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.CreatedAt = a.CreatedAt.UTC()
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) scanFeatureRequest(rows interface {
	Scan(...any) error
}) (FeatureRequest, error) {
	var fr FeatureRequest
	if err := rows.Scan(&fr.ID, &fr.From, &fr.Text, &fr.Status, &fr.AdminComment, &fr.CreatedAt); err != nil {
		return fr, err
	}
	fr.CreatedAt = fr.CreatedAt.UTC()
	return fr, nil
}

const featureRequestSelectCols = `id, from_user, text, status, admin_comment, created_at`

// loadAttachmentsForRequests fetches every attachment belonging to any
// of the given requests in a single query and grafts them onto the
// matching FeatureRequest structs. Called by the list/get helpers so
// callers get a fully-populated tree in one shot.
func (s *Store) loadAttachmentsForRequests(list []FeatureRequest) error {
	if len(list) == 0 {
		return nil
	}
	placeholders := make([]string, len(list))
	args := make([]any, len(list))
	idx := make(map[int64]*FeatureRequest, len(list))
	for i := range list {
		placeholders[i] = "$" + strconv.Itoa(i+1)
		args[i] = list[i].ID
		idx[list[i].ID] = &list[i]
	}
	q := `SELECT id, feature_request_id, filename, original_name, mime, size, created_at
	      FROM feature_request_attachments
	      WHERE feature_request_id IN (` + strings.Join(placeholders, ",") + `)
	      ORDER BY feature_request_id, id`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a FeatureRequestAttachment
		var frID int64
		if err := rows.Scan(&a.ID, &frID, &a.Filename, &a.OriginalName, &a.Mime, &a.Size, &a.CreatedAt); err != nil {
			return err
		}
		a.CreatedAt = a.CreatedAt.UTC()
		if fr, ok := idx[frID]; ok {
			fr.Attachments = append(fr.Attachments, a)
		}
	}
	return rows.Err()
}

func (s *Store) ListFeatureRequests() ([]FeatureRequest, error) {
	rows, err := s.db.Query(
		`SELECT ` + featureRequestSelectCols + ` FROM feature_requests ORDER BY id DESC`)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadAttachmentsForRequests(out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) ListFeatureRequestsByUser(username string) ([]FeatureRequest, error) {
	rows, err := s.db.Query(
		`SELECT `+featureRequestSelectCols+` FROM feature_requests WHERE from_user=$1 ORDER BY id DESC`,
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadAttachmentsForRequests(out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetFeatureRequest fetches a single request with its attachments loaded.
// Returns ErrNotFound when no row with the given id exists.
func (s *Store) GetFeatureRequest(id int64) (*FeatureRequest, error) {
	row := s.db.QueryRow(
		`SELECT `+featureRequestSelectCols+` FROM feature_requests WHERE id=$1`, id)
	fr, err := s.scanFeatureRequest(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	list := []FeatureRequest{fr}
	if err := s.loadAttachmentsForRequests(list); err != nil {
		return nil, err
	}
	return &list[0], nil
}

func (s *Store) UpdateFeatureRequestStatus(id int64, status string) error {
	_, err := s.db.Exec(`UPDATE feature_requests SET status=$1 WHERE id=$2`, status, id)
	return err
}

func (s *Store) UpdateFeatureRequestComment(id int64, comment string) error {
	_, err := s.db.Exec(`UPDATE feature_requests SET admin_comment=$1 WHERE id=$2`, comment, id)
	return err
}

func (s *Store) DeleteFeatureRequest(id int64) error {
	_, err := s.db.Exec(`DELETE FROM feature_requests WHERE id=$1`, id)
	return err
}

// LoadSettings returns the persisted settings, falling back to defaults.
func (s *Store) LoadSettings() (Settings, error) {
	defaults := Settings{
		DefaultMode:         "SSB",
		DefaultBand:         "20m",
		BackupRetentionDays: 30,
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
		case "backup_retention_days":
			// 0 is a legal value meaning "keep forever" — allow it
			// alongside positive integers; negative values are
			// treated as "unset, use default".
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				out.BackupRetentionDays = n
			}
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
	// Always persist backup_retention_days so 0 (== "keep forever")
	// is round-trippable through the settings UI.
	if set.BackupRetentionDays >= 0 {
		pairs = append(pairs, [2]string{"backup_retention_days", strconv.Itoa(set.BackupRetentionDays)})
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range pairs {
		if _, err := tx.Exec(
			`INSERT INTO settings(key,value) VALUES($1,$2)
			 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
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
		`INSERT INTO settings(key,value) VALUES('helper_token',$1)
		 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, tok)
	return err
}

// ----- cluster spots -----

// SaveClusterSpot inserts a spot into the database. Every string field
// goes through cleanStr() first — DX-cluster comments occasionally
// arrive as Latin-1 (European operators typing accented characters
// into a byte-oriented AR-cluster client) and Postgres rejects
// non-UTF-8 payloads with SQLSTATE 22021, which would silently drop
// the spot.
func (s *Store) SaveClusterSpot(sp ClusterSpot) error {
	_, err := s.db.Exec(
		`INSERT INTO cluster_spots(time_str,dx,freq,band,mode,comment,spotter) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		cleanStr(sp.Time), cleanStr(sp.DX), cleanStr(sp.Freq),
		cleanStr(sp.Band), cleanStr(sp.Mode), cleanStr(sp.Comment), cleanStr(sp.Spotter))
	return err
}

// LoadRecentClusterSpots returns the most recent limit spots ordered newest first.
func (s *Store) LoadRecentClusterSpots(limit int) ([]ClusterSpot, error) {
	rows, err := s.db.Query(
		`SELECT id,time_str,dx,freq,band,mode,comment,spotter,created_at
		 FROM cluster_spots ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClusterSpot
	for rows.Next() {
		var sp ClusterSpot
		var createdAt time.Time
		if err := rows.Scan(&sp.ID, &sp.Time, &sp.DX, &sp.Freq, &sp.Band, &sp.Mode, &sp.Comment, &sp.Spotter, &createdAt); err != nil {
			return nil, err
		}
		// Preserve the historical wire format (SQLite `datetime('now')`
		// rendered as "2006-01-02 15:04:05") so the frontend and any
		// dependent callers don't need retuning during the migration.
		sp.CreatedAt = createdAt.UTC().Format("2006-01-02 15:04:05")
		out = append(out, sp)
	}
	return out, rows.Err()
}

// PruneClusterSpots deletes spots older than retentionDays days.
func (s *Store) PruneClusterSpots(retentionDays int) error {
	_, err := s.db.Exec(
		`DELETE FROM cluster_spots WHERE created_at < NOW() - make_interval(days => $1)`,
		retentionDays)
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
		id         BIGSERIAL PRIMARY KEY,
		contest_id BIGINT NOT NULL,
		from_call  TEXT NOT NULL,
		username   TEXT NOT NULL,
		text       TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL
	)`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_contest ON chat_messages(contest_id, created_at)`)
	return err
}

// InsertChatMessage persists a chat message. timeStr is an RFC3339 string
// (retained for API compatibility with the WebSocket layer); it is parsed
// and stored as a proper TIMESTAMPTZ.
func (s *Store) InsertChatMessage(contestID int64, from, user, text, timeStr string) error {
	ts, err := time.Parse(time.RFC3339, timeStr)
	if err != nil {
		ts = time.Now().UTC()
	}
	_, err = s.db.Exec(
		`INSERT INTO chat_messages (contest_id, from_call, username, text, created_at) VALUES ($1, $2, $3, $4, $5)`,
		contestID, cleanStr(from), cleanStr(user), cleanStr(text), ts,
	)
	return err
}

// RecentChatMessages returns messages sent within the last 24 hours for the given contest, oldest first.
func (s *Store) RecentChatMessages(contestID int64) ([]ChatMessage, error) {
	cutoff := time.Now().UTC().Add(-24 * time.Hour)
	rows, err := s.db.Query(
		`SELECT from_call, username, text, created_at FROM chat_messages
		 WHERE contest_id = $1 AND created_at > $2 ORDER BY id ASC`,
		contestID, cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.From, &m.User, &m.Text, &m.Time); err != nil {
			return nil, err
		}
		m.Time = m.Time.UTC()
		m.ContestID = contestID
		out = append(out, m)
	}
	return out, rows.Err()
}

// PruneChatMessages deletes messages older than 24 hours.
func (s *Store) PruneChatMessages() error {
	_, err := s.db.Exec(`DELETE FROM chat_messages WHERE created_at <= NOW() - INTERVAL '24 hours'`)
	return err
}

// ----- dummy rigs -----

func (s *Store) migrateDummyRigs() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS dummy_rigs (
		name             TEXT PRIMARY KEY,
		default_freq_hz  BIGINT NOT NULL DEFAULT 14000000
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
		`INSERT INTO dummy_rigs(name, default_freq_hz) VALUES($1, $2)`,
		name, defaultFreqHz)
	return err
}

// DeleteDummyRig removes a dummy TRX configuration.
func (s *Store) DeleteDummyRig(name string) error {
	_, err := s.db.Exec(`DELETE FROM dummy_rigs WHERE name = $1`, name)
	return err
}

// ----- callsign DOK cache -----

func (s *Store) migrateCallsignCache() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS callsign_cache (
		callsign   TEXT PRIMARY KEY,
		dok        TEXT NOT NULL DEFAULT '',
		updated_at TIMESTAMPTZ NOT NULL
	)`)
	return err
}

// UpsertCallsignDOK stores or updates the DOK for a callsign. cleanStr()
// covers the case where the upstream QRZ / DXCC lookup returns
// non-UTF-8 bytes in a call-sign or DOK field — rare in practice but
// Postgres would reject the whole INSERT.
func (s *Store) UpsertCallsignDOK(callsign, dok string) error {
	_, err := s.db.Exec(
		`INSERT INTO callsign_cache(callsign, dok, updated_at) VALUES($1, $2, $3)
		 ON CONFLICT(callsign) DO UPDATE SET dok=EXCLUDED.dok, updated_at=EXCLUDED.updated_at`,
		cleanStr(strings.ToUpper(callsign)), cleanStr(strings.ToUpper(dok)), time.Now().UTC(),
	)
	return err
}

// GetCachedDOK returns the cached DOK for a callsign, or "" if not found.
func (s *Store) GetCachedDOK(callsign string) string {
	var dok string
	_ = s.db.QueryRow(`SELECT dok FROM callsign_cache WHERE callsign = $1`, strings.ToUpper(callsign)).Scan(&dok)
	return dok
}

// CallsignCacheEntry is one row of the callsign→DOK cache. UpdatedAt is
// preserved as a string on the JSON boundary to keep the frontend contract
// stable across the DB migration.
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
		var updatedAt time.Time
		if err := rows.Scan(&e.Callsign, &e.DOK, &updatedAt); err != nil {
			return nil, err
		}
		e.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteCallsignDOK removes a callsign entry from the cache.
func (s *Store) DeleteCallsignDOK(callsign string) error {
	_, err := s.db.Exec(`DELETE FROM callsign_cache WHERE callsign = $1`, strings.ToUpper(callsign))
	return err
}
