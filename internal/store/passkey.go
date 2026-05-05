package store

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// PasskeyCredential is a stored WebAuthn credential with metadata.
type PasskeyCredential struct {
	ID        string    // base64url of credential.ID
	UserID    int64
	Name      string
	CreatedAt time.Time
}

func (s *Store) migratePasskeys() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS webauthn_credentials (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
		)`,
		`CREATE TABLE IF NOT EXISTS webauthn_sessions (
			id TEXT PRIMARY KEY,
			data TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate passkeys: %w", err)
		}
	}
	return nil
}

// GetPasskeyCredentials returns all webauthn.Credential objects for a user.
func (s *Store) GetPasskeyCredentials(userID int64) ([]webauthn.Credential, error) {
	rows, err := s.db.Query(
		`SELECT data FROM webauthn_credentials WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var creds []webauthn.Credential
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c webauthn.Credential
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		creds = append(creds, c)
	}
	return creds, rows.Err()
}

// ListPasskeyCredentials returns credential metadata (for the management UI).
func (s *Store) ListPasskeyCredentials(userID int64) ([]PasskeyCredential, error) {
	rows, err := s.db.Query(
		`SELECT id, name, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PasskeyCredential
	for rows.Next() {
		var pc PasskeyCredential
		var ts string
		if err := rows.Scan(&pc.ID, &pc.Name, &ts); err != nil {
			return nil, err
		}
		pc.UserID = userID
		pc.CreatedAt, _ = time.Parse(time.RFC3339, ts)
		out = append(out, pc)
	}
	return out, rows.Err()
}

// SavePasskeyCredential persists a new credential after successful registration.
func (s *Store) SavePasskeyCredential(userID int64, name string, cred *webauthn.Credential) error {
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	id := base64.RawURLEncoding.EncodeToString(cred.ID)
	_, err = s.db.Exec(
		`INSERT INTO webauthn_credentials (id, user_id, name, data, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, userID, name, string(raw), time.Now().UTC().Format(time.RFC3339))
	return err
}

// UpdatePasskeyCredential replaces the stored credential data (sign count etc).
func (s *Store) UpdatePasskeyCredential(cred *webauthn.Credential) error {
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	id := base64.RawURLEncoding.EncodeToString(cred.ID)
	_, err = s.db.Exec(
		`UPDATE webauthn_credentials SET data = ? WHERE id = ?`, string(raw), id)
	return err
}

// DeletePasskeyCredential removes a credential.  userID scopes deletion to the owner.
func (s *Store) DeletePasskeyCredential(credID string, userID int64) error {
	_, err := s.db.Exec(
		`DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`, credID, userID)
	return err
}

// SavePasskeySession persists a WebAuthn session (challenge data) for TTL minutes.
func (s *Store) SavePasskeySession(id string, data *webauthn.SessionData, expiresAt time.Time) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT OR REPLACE INTO webauthn_sessions (id, data, expires_at) VALUES (?, ?, ?)`,
		id, string(raw), expiresAt.UTC().Format(time.RFC3339))
	return err
}

// GetPasskeySession retrieves and deletes a WebAuthn session (single-use).
func (s *Store) GetPasskeySession(id string) (*webauthn.SessionData, error) {
	row := s.db.QueryRow(
		`SELECT data, expires_at FROM webauthn_sessions WHERE id = ?`, id)
	var raw, expiresStr string
	if err := row.Scan(&raw, &expiresStr); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	expires, _ := time.Parse(time.RFC3339, expiresStr)
	if time.Now().After(expires) {
		_ = s.DeletePasskeySession(id)
		return nil, ErrNotFound
	}
	var sd webauthn.SessionData
	if err := json.Unmarshal([]byte(raw), &sd); err != nil {
		return nil, err
	}
	_ = s.DeletePasskeySession(id)
	return &sd, nil
}

// DeletePasskeySession removes a WebAuthn session.
func (s *Store) DeletePasskeySession(id string) error {
	_, err := s.db.Exec(`DELETE FROM webauthn_sessions WHERE id = ?`, id)
	return err
}

// PrunePasskeySessions deletes all expired sessions.
func (s *Store) PrunePasskeySessions() error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`DELETE FROM webauthn_sessions WHERE expires_at < ?`, now)
	return err
}
