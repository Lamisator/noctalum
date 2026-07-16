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
			id         TEXT PRIMARY KEY,
			user_id    BIGINT NOT NULL,
			csrf_token TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			last_seen  TIMESTAMPTZ NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL
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
		`INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT(id) DO UPDATE SET
		    user_id    = EXCLUDED.user_id,
		    csrf_token = EXCLUDED.csrf_token,
		    created_at = EXCLUDED.created_at,
		    last_seen  = EXCLUDED.last_seen,
		    expires_at = EXCLUDED.expires_at`,
		row.ID, row.UserID, row.CSRFToken,
		row.CreatedAt.UTC(), row.LastSeen.UTC(), row.ExpiresAt.UTC(),
	)
	return err
}

// TouchSession updates last_seen and expires_at for a session.
func (s *Store) TouchSession(id string, lastSeen, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`UPDATE sessions SET last_seen = $1, expires_at = $2 WHERE id = $3`,
		lastSeen.UTC(), expiresAt.UTC(), id,
	)
	return err
}

// LoadSessions returns all non-expired session records.
func (s *Store) LoadSessions() ([]SessionRow, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id, csrf_token, created_at, last_seen, expires_at
		 FROM sessions WHERE expires_at > $1`, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionRow
	for rows.Next() {
		var r SessionRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.CSRFToken, &r.CreatedAt, &r.LastSeen, &r.ExpiresAt); err != nil {
			return nil, err
		}
		r.CreatedAt = r.CreatedAt.UTC()
		r.LastSeen = r.LastSeen.UTC()
		r.ExpiresAt = r.ExpiresAt.UTC()
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteSession removes a single session.
func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = $1`, id)
	return err
}

// DeleteSessionsForUser removes all sessions belonging to a user.
func (s *Store) DeleteSessionsForUser(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE user_id = $1`, userID)
	return err
}

// DeleteExpiredSessions prunes sessions whose expires_at is in the past.
func (s *Store) DeleteExpiredSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at <= $1`, time.Now().UTC())
	return err
}
