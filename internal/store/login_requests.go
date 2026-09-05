package store

import (
	"database/sql"
	"errors"
	"time"
)

// LoginRequestStatus is the lifecycle marker for a device-pairing login request.
type LoginRequestStatus string

const (
	LoginRequestPending  LoginRequestStatus = "pending"
	LoginRequestApproved LoginRequestStatus = "approved"
	LoginRequestDenied   LoginRequestStatus = "denied"
	LoginRequestConsumed LoginRequestStatus = "consumed"
)

// What an approval is being asked for.  The same QR/approve machinery serves
// two flows, and the purpose keeps them apart: an approved "log this device
// in" must never be redeemable as "activate admin permissions", and it also
// lets the approver's dialog say which of the two they are agreeing to.
const (
	LoginRequestPurposeLogin   = "login"
	LoginRequestPurposeElevate = "elevate"
)

// LoginRequest is one outstanding "log in another device" pairing.
// It is created (unauthenticated) by the device that wants to log in and
// approved (or denied) by an already-authenticated user on another device.
type LoginRequest struct {
	ID          string
	RequesterIP string
	RequesterUA string
	Status      LoginRequestStatus
	Purpose     string // LoginRequestPurposeLogin | LoginRequestPurposeElevate
	// RequesterUserID is 0 for a device login (nobody is signed in on the
	// requesting device yet) and the signed-in user for an elevation.
	RequesterUserID int64
	ApproverUserID  int64
	CreatedAt       time.Time
	ExpiresAt       time.Time
	DecidedAt       *time.Time
}

func (s *Store) migrateLoginRequests() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS login_requests (
			id                TEXT PRIMARY KEY,
			requester_ip      TEXT NOT NULL,
			requester_ua      TEXT NOT NULL,
			status            TEXT NOT NULL,
			approver_user_id  BIGINT NOT NULL DEFAULT 0,
			created_at        TIMESTAMPTZ NOT NULL,
			expires_at        TIMESTAMPTZ NOT NULL,
			decided_at        TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_login_requests_expires_at ON login_requests(expires_at)`,
		// Added with admin elevation; existing rows are plain logins.
		`ALTER TABLE login_requests ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login'`,
		// Set only for elevation requests, where the device asking is
		// already signed in and only that same account may approve.
		`ALTER TABLE login_requests ADD COLUMN IF NOT EXISTS requester_user_id BIGINT NOT NULL DEFAULT 0`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// CreateLoginRequest inserts a pending pairing request.  purpose is one of
// the LoginRequestPurpose* constants; an empty value means a plain login.
func (s *Store) CreateLoginRequest(id, ip, ua, purpose string, requesterUserID int64, createdAt, expiresAt time.Time) error {
	if purpose == "" {
		purpose = LoginRequestPurposeLogin
	}
	_, err := s.db.Exec(
		`INSERT INTO login_requests (id, requester_ip, requester_ua, status, purpose, requester_user_id, created_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, ip, ua, string(LoginRequestPending), purpose, requesterUserID, createdAt.UTC(), expiresAt.UTC(),
	)
	return err
}

// GetLoginRequest returns the row for id (or ErrNotFound).
func (s *Store) GetLoginRequest(id string) (LoginRequest, error) {
	row := s.db.QueryRow(
		`SELECT id, requester_ip, requester_ua, status, purpose, requester_user_id, approver_user_id, created_at, expires_at, decided_at
		 FROM login_requests WHERE id = $1`, id)
	var r LoginRequest
	var status string
	var decided sql.NullTime
	if err := row.Scan(&r.ID, &r.RequesterIP, &r.RequesterUA, &status, &r.Purpose,
		&r.RequesterUserID, &r.ApproverUserID,
		&r.CreatedAt, &r.ExpiresAt, &decided); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return LoginRequest{}, ErrNotFound
		}
		return LoginRequest{}, err
	}
	r.Status = LoginRequestStatus(status)
	r.CreatedAt = r.CreatedAt.UTC()
	r.ExpiresAt = r.ExpiresAt.UTC()
	if decided.Valid {
		t := decided.Time.UTC()
		r.DecidedAt = &t
	}
	return r, nil
}

// DecideLoginRequest atomically flips a pending request to approved/denied.
// Returns ErrNotFound if the request no longer exists or is not pending
// (already decided / consumed / expired at the DB level).
func (s *Store) DecideLoginRequest(id string, approve bool, approverUserID int64, decidedAt time.Time) error {
	newStatus := LoginRequestDenied
	if approve {
		newStatus = LoginRequestApproved
	}
	// requester_user_id = 0 covers device logins, where anyone signed in may
	// approve; a non-zero value (an elevation) additionally demands that the
	// approver is that same account, enforced in the UPDATE so a race cannot
	// slip past the handler's own check.
	res, err := s.db.Exec(
		`UPDATE login_requests
		 SET status = $1, approver_user_id = $2, decided_at = $3
		 WHERE id = $4 AND status = $5 AND expires_at > $6
		   AND (requester_user_id = 0 OR requester_user_id = $2)`,
		string(newStatus), approverUserID, decidedAt.UTC(), id,
		string(LoginRequestPending), decidedAt.UTC(),
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ConsumeLoginRequest flips an approved request to consumed, ensuring
// single-use semantics for the requesting device's poll.  Returns the
// approver_user_id on success.  Returns ErrNotFound if the request is
// missing, not approved, already consumed, or was approved for a different
// purpose than the caller is redeeming it for — so an approved device login
// can never be cashed in as an admin elevation.
func (s *Store) ConsumeLoginRequest(id, purpose string, at time.Time) (int64, error) {
	if purpose == "" {
		purpose = LoginRequestPurposeLogin
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var approver int64
	var status, storedPurpose string
	if err := tx.QueryRow(
		`SELECT status, purpose, approver_user_id FROM login_requests
		 WHERE id = $1 FOR UPDATE`, id).Scan(&status, &storedPurpose, &approver); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if LoginRequestStatus(status) != LoginRequestApproved || storedPurpose != purpose {
		return 0, ErrNotFound
	}
	if _, err := tx.Exec(
		`UPDATE login_requests SET status = $1, decided_at = $2 WHERE id = $3`,
		string(LoginRequestConsumed), at.UTC(), id,
	); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return approver, nil
}

// DeleteExpiredLoginRequests prunes rows past their expires_at.  Called on
// the same interval that expires sessions.
func (s *Store) DeleteExpiredLoginRequests() error {
	_, err := s.db.Exec(`DELETE FROM login_requests WHERE expires_at <= $1`, time.Now().UTC())
	return err
}
