package store

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// CallsignRequest is a user-submitted request to change their personal
// callsign, awaiting review by an operator with the
// "callsign_requests.review" permission. The uploaded proof (a scan of a
// licence document, typically JPG/PNG/PDF) is stored on the filesystem;
// this row only carries the safe on-disk filename plus its MIME type and
// size so the admin UI can decide whether to render inline or as a link.
type CallsignRequest struct {
	ID                int64      `json:"id"`
	UserID            int64      `json:"user_id"`
	Username          string     `json:"username"`
	CurrentCallsign   string     `json:"current_callsign"`
	RequestedCallsign string     `json:"requested_callsign"`
	ProofFilename     string     `json:"proof_filename"`
	ProofMime         string     `json:"proof_mime"`
	ProofSize         int64      `json:"proof_size"`
	Status            string     `json:"status"` // pending | approved | rejected
	AdminNote         string     `json:"admin_note"`
	CreatedAt         time.Time  `json:"created_at"`
	DecidedByUserID   *int64     `json:"decided_by_user_id,omitempty"`
	DecidedBy         string     `json:"decided_by,omitempty"`
	DecidedAt         *time.Time `json:"decided_at,omitempty"`
}

func (s *Store) migrateCallsignRequests() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS callsign_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		current_callsign TEXT NOT NULL,
		requested_callsign TEXT NOT NULL,
		proof_filename TEXT NOT NULL,
		proof_mime TEXT NOT NULL,
		proof_size INTEGER NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		admin_note TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		decided_by INTEGER,
		decided_at TEXT,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_callsign_requests_status ON callsign_requests(status, id DESC)`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_callsign_requests_user ON callsign_requests(user_id, status)`)
	return err
}

// InsertCallsignRequest stores a new pending request and returns the row id.
func (s *Store) InsertCallsignRequest(userID int64, currentCall, requestedCall, filename, mime string, size int64) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.Exec(
		`INSERT INTO callsign_requests (user_id, current_callsign, requested_callsign,
			proof_filename, proof_mime, proof_size, status, admin_note, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?)`,
		userID, strings.ToUpper(currentCall), strings.ToUpper(requestedCall),
		filename, mime, size, now,
	)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

// GetPendingCallsignRequestByUser returns the user's outstanding request if
// any (ErrNotFound otherwise). Used to enforce one-in-flight per user and to
// render the "your request is pending review" hint in Personal Settings.
func (s *Store) GetPendingCallsignRequestByUser(userID int64) (CallsignRequest, error) {
	return s.getCallsignRequest(`cr.user_id = ? AND cr.status = 'pending'`, userID)
}

// GetCallsignRequestByID fetches a single request (with username resolved).
func (s *Store) GetCallsignRequestByID(id int64) (CallsignRequest, error) {
	return s.getCallsignRequest(`cr.id = ?`, id)
}

func (s *Store) getCallsignRequest(where string, arg interface{}) (CallsignRequest, error) {
	row := s.db.QueryRow(
		`SELECT cr.id, cr.user_id, u.username, cr.current_callsign, cr.requested_callsign,
		        cr.proof_filename, cr.proof_mime, cr.proof_size, cr.status, cr.admin_note,
		        cr.created_at, cr.decided_by, cr.decided_at,
		        (SELECT username FROM users WHERE id = cr.decided_by)
		 FROM callsign_requests cr
		 JOIN users u ON u.id = cr.user_id
		 WHERE `+where+` ORDER BY cr.id DESC LIMIT 1`, arg)
	return scanCallsignRequest(row)
}

// ListCallsignRequests returns every request, newest first. Pending
// requests sort ahead of decided ones so the admin panel highlights work
// left to do.
func (s *Store) ListCallsignRequests() ([]CallsignRequest, error) {
	rows, err := s.db.Query(
		`SELECT cr.id, cr.user_id, u.username, cr.current_callsign, cr.requested_callsign,
		        cr.proof_filename, cr.proof_mime, cr.proof_size, cr.status, cr.admin_note,
		        cr.created_at, cr.decided_by, cr.decided_at,
		        (SELECT username FROM users WHERE id = cr.decided_by)
		 FROM callsign_requests cr
		 JOIN users u ON u.id = cr.user_id
		 ORDER BY (cr.status = 'pending') DESC, cr.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CallsignRequest
	for rows.Next() {
		cr, err := scanCallsignRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cr)
	}
	return out, rows.Err()
}

// DecideCallsignRequest marks a pending request as approved or rejected,
// recording who decided it, when, and an optional note. Returns
// ErrNotFound if no pending row with that id exists (prevents double
// decisions from racing admins).
func (s *Store) DecideCallsignRequest(id, decidedBy int64, status, note string) error {
	if status != "approved" && status != "rejected" {
		return errors.New("status must be 'approved' or 'rejected'")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.Exec(
		`UPDATE callsign_requests SET status = ?, admin_note = ?, decided_by = ?, decided_at = ?
		 WHERE id = ? AND status = 'pending'`,
		status, note, decidedBy, now, id,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanCallsignRequest(r rowScanner) (CallsignRequest, error) {
	var cr CallsignRequest
	var createdAt string
	var decidedByN sql.NullInt64
	var decidedAtN sql.NullString
	var decidedByName sql.NullString
	err := r.Scan(&cr.ID, &cr.UserID, &cr.Username, &cr.CurrentCallsign, &cr.RequestedCallsign,
		&cr.ProofFilename, &cr.ProofMime, &cr.ProofSize, &cr.Status, &cr.AdminNote,
		&createdAt, &decidedByN, &decidedAtN, &decidedByName)
	if errors.Is(err, sql.ErrNoRows) {
		return cr, ErrNotFound
	}
	if err != nil {
		return cr, err
	}
	cr.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	if decidedByN.Valid {
		v := decidedByN.Int64
		cr.DecidedByUserID = &v
	}
	if decidedAtN.Valid && decidedAtN.String != "" {
		t, _ := time.Parse(time.RFC3339, decidedAtN.String)
		cr.DecidedAt = &t
	}
	if decidedByName.Valid {
		cr.DecidedBy = decidedByName.String
	}
	return cr, nil
}
