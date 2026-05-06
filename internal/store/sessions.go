package store

import (
	"time"
)

// SessionRow is a persisted session record.
type SessionRow struct {
	ID        string
	UserID    int64
	CSRFToken string
	CreatedAt time.Time
	LastSeen  time.Time
	ExpiresAt time.Time
}

func (s *Store) migrateSessions() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL,
			csrf_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// SaveSession inserts or replaces a session record.
func (s *Store) SaveSession(row SessionRow) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO sessions (id, user_id, csrf_token, created_at, last_seen, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		row.ID, row.UserID, row.CSRFToken,
		row.CreatedAt.UTC().Format(time.RFC3339),
		row.LastSeen.UTC().Format(time.RFC3339),
		row.ExpiresAt.UTC().Format(time.RFC3339),
	)
	return err
}

// TouchSession updates last_seen and expires_at for a session.
func (s *Store) TouchSession(id string, lastSeen, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?`,
		lastSeen.UTC().Format(time.RFC3339),
		expiresAt.UTC().Format(time.RFC3339),
		id,
	)
	return err
}

// LoadSessions returns all non-expired session records.
func (s *Store) LoadSessions() ([]SessionRow, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := s.db.Query(
		`SELECT id, user_id, csrf_token, created_at, last_seen, expires_at
		 FROM sessions WHERE expires_at > ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionRow
	for rows.Next() {
		var r SessionRow
		var createdAt, lastSeen, expiresAt string
		if err := rows.Scan(&r.ID, &r.UserID, &r.CSRFToken, &createdAt, &lastSeen, &expiresAt); err != nil {
			return nil, err
		}
		r.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		r.LastSeen, _ = time.Parse(time.RFC3339, lastSeen)
		r.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteSession removes a single session.
func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// DeleteSessionsForUser removes all sessions belonging to a user.
func (s *Store) DeleteSessionsForUser(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

// DeleteExpiredSessions prunes sessions whose expires_at is in the past.
func (s *Store) DeleteExpiredSessions() error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, now)
	return err
}
