package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrShareNotFound = errors.New("share not found")

// ContestShare is a server-stored snapshot of a contest's configuration that
// can be imported by another operator via a token-bearing URL.  Sensitive
// per-operator fields (station_call, station_id, qth) are intentionally NOT
// part of the snapshot — the importing operator supplies their own.
type ContestShare struct {
	Token         string    `json:"token"`
	ContestID     int64     `json:"contest_id"`
	OwnerUserID   int64     `json:"owner_user_id"`
	SourceName    string    `json:"source_name"`
	Payload       string    `json:"payload"` // JSON-encoded SharePayload
	CreatedAt     time.Time `json:"created_at"`
}

// SharePayload is what gets serialised into ContestShare.Payload — exactly
// the configuration the importer can apply to a new or existing contest.
type SharePayload struct {
	CustomFields       string   `json:"custom_fields"`
	QSOLayout          string   `json:"qso_layout"`
	LogColumns         string   `json:"log_columns"`
	Bands              []string `json:"bands"`
	Objective          string   `json:"objective"`
	NrPadded           bool     `json:"nr_padded"`
	StashExpiryMinutes int64    `json:"stash_expiry_minutes"`
}

func (s *Store) migrateShares() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS contest_shares (
			token TEXT PRIMARY KEY,
			contest_id INTEGER NOT NULL,
			owner_user_id INTEGER NOT NULL,
			source_name TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_contest_shares_contest ON contest_shares(contest_id)`,
		`CREATE INDEX IF NOT EXISTS idx_contest_shares_owner ON contest_shares(owner_user_id)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate contest_shares: %w", err)
		}
	}
	return nil
}

// generateShareToken returns a 22-char URL-safe random string (~128 bits of
// entropy).  Tokens act as bearer credentials so the random source is
// crypto/rand, not math/rand.
func generateShareToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(b[:])
	return tok, nil
}

// BuildSharePayload assembles the snapshot for a contest.  Excludes station
// identity fields so the same snapshot can be reused across operators.
func BuildSharePayload(c *Contest) (string, error) {
	p := SharePayload{
		CustomFields:       c.CustomFields,
		QSOLayout:          c.QSOLayout,
		LogColumns:         c.LogColumns,
		Bands:              c.Bands,
		Objective:          c.Objective,
		NrPadded:           c.NrPadded,
		StashExpiryMinutes: c.StashExpiryMinutes,
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// CreateShare stores a fresh snapshot of the source contest's configuration
// and returns the bearer token.  The same source can have multiple active
// shares; the caller is responsible for deleting stale ones if desired.
func (s *Store) CreateShare(contestID, ownerUserID int64, sourceName, payload string) (*ContestShare, error) {
	token, err := generateShareToken()
	if err != nil {
		return nil, fmt.Errorf("generate share token: %w", err)
	}
	now := time.Now().UTC()
	_, err = s.db.Exec(
		`INSERT INTO contest_shares (token, contest_id, owner_user_id, source_name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		token, contestID, ownerUserID, strings.TrimSpace(sourceName), payload, now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, err
	}
	return &ContestShare{
		Token:       token,
		ContestID:   contestID,
		OwnerUserID: ownerUserID,
		SourceName:  sourceName,
		Payload:     payload,
		CreatedAt:   now,
	}, nil
}

// GetShare returns a single share by token, or ErrShareNotFound.
func (s *Store) GetShare(token string) (*ContestShare, error) {
	row := s.db.QueryRow(
		`SELECT token, contest_id, owner_user_id, source_name, payload, created_at FROM contest_shares WHERE token = ?`,
		token,
	)
	var sh ContestShare
	var t string
	if err := row.Scan(&sh.Token, &sh.ContestID, &sh.OwnerUserID, &sh.SourceName, &sh.Payload, &t); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	sh.CreatedAt, _ = time.Parse(time.RFC3339, t)
	return &sh, nil
}

// ListSharesByContest returns every active share for a contest, newest first.
func (s *Store) ListSharesByContest(contestID int64) ([]ContestShare, error) {
	rows, err := s.db.Query(
		`SELECT token, contest_id, owner_user_id, source_name, payload, created_at FROM contest_shares WHERE contest_id = ? ORDER BY created_at DESC`,
		contestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContestShare
	for rows.Next() {
		var sh ContestShare
		var t string
		if err := rows.Scan(&sh.Token, &sh.ContestID, &sh.OwnerUserID, &sh.SourceName, &sh.Payload, &t); err != nil {
			return nil, err
		}
		sh.CreatedAt, _ = time.Parse(time.RFC3339, t)
		out = append(out, sh)
	}
	return out, rows.Err()
}

// DeleteShare removes a share.  Returns ErrShareNotFound if the token doesn't
// exist; the caller is expected to authorise the delete before invoking.
func (s *Store) DeleteShare(token string) error {
	res, err := s.db.Exec(`DELETE FROM contest_shares WHERE token = ?`, token)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrShareNotFound
	}
	return nil
}

// DeleteSharesForContest removes every share that points at a contest.
// Called automatically when the source contest is deleted.
func (s *Store) DeleteSharesForContest(contestID int64) error {
	_, err := s.db.Exec(`DELETE FROM contest_shares WHERE contest_id = ?`, contestID)
	return err
}
