package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// User is one account that can log in to the application.
type User struct {
	ID               int64      `json:"id"`
	Username         string     `json:"username"`
	Callsign         string     `json:"callsign"`
	PasswordHash     string     `json:"-"`
	HelperToken      string     `json:"-"` // per-user helper auth token, never sent to the browser in user lists
	FailedAttempts   int        `json:"failed_attempts"`
	LockedUntil      *time.Time `json:"locked_until,omitempty"`
	Disabled         bool       `json:"disabled"`
	CreatedAt        time.Time  `json:"created_at"`
	LastActivityAt   *time.Time `json:"last_activity_at,omitempty"`
	Roles            []string   `json:"roles"`
	Permissions      []string   `json:"permissions"`
}

func generateHelperToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// Role groups a set of permission keys.
type Role struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
	IsBuiltin   bool     `json:"is_builtin"`
}

// ErrNotFound is returned when a lookup yields no row.
var ErrNotFound = errors.New("not found")

// ErrUsernameTaken is returned by CreateUser if the username already exists.
var ErrUsernameTaken = errors.New("username already taken")

// ErrRoleNameTaken is returned by CreateRole if the role name already exists.
var ErrRoleNameTaken = errors.New("role name already taken")

func (s *Store) migrateUsers() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			callsign TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			failed_attempts INTEGER NOT NULL DEFAULT 0,
			locked_until TEXT,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS roles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			permissions TEXT NOT NULL DEFAULT '',
			is_builtin INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS user_roles (
			user_id INTEGER NOT NULL,
			role_id INTEGER NOT NULL,
			PRIMARY KEY (user_id, role_id),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
		)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate users: %w", err)
		}
	}
	// Add helper_token column if not present, then populate any empty slots.
	_, _ = s.db.Exec(`ALTER TABLE users ADD COLUMN helper_token TEXT NOT NULL DEFAULT ''`)
	_, err := s.db.Exec(
		`UPDATE users SET helper_token = lower(hex(randomblob(24))) WHERE helper_token = ''`)
	if err != nil {
		return err
	}
	_, _ = s.db.Exec(`ALTER TABLE users ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''`)
	return nil
}

// EnsureBuiltinRoles inserts the default "admin" and "user" roles if missing.
// "admin" is special: its permissions list contains "*" (interpreted as
// every permission by the server). It cannot be deleted or renamed.
func (s *Store) EnsureBuiltinRoles(userPerms []string) error {
	if err := s.upsertBuiltinRole("admin", []string{"*"}); err != nil {
		return err
	}
	return s.upsertBuiltinRole("user", userPerms)
}

func (s *Store) upsertBuiltinRole(name string, perms []string) error {
	csv := strings.Join(perms, ",")
	_, err := s.db.Exec(
		`INSERT INTO roles (name, permissions, is_builtin) VALUES (?, ?, 1)
		 ON CONFLICT(name) DO UPDATE SET is_builtin=1`,
		name, csv)
	return err
}

// CountUsers returns how many users exist (used to drive first-run setup).
func (s *Store) CountUsers() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser inserts a new user with a bcrypt-hashed password and assigns roles.
// roleNames must reference existing roles; unknown names are ignored.
func (s *Store) CreateUser(username, callsign, plainPassword string, roleNames []string) (User, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	callsign = strings.ToUpper(strings.TrimSpace(callsign))
	if username == "" || plainPassword == "" {
		return User{}, errors.New("username and password are required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plainPassword), 12)
	if err != nil {
		return User{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`INSERT INTO users (username, callsign, password_hash, helper_token, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		username, callsign, string(hash), generateHelperToken(), time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return User{}, ErrUsernameTaken
		}
		return User{}, err
	}
	id, _ := res.LastInsertId()

	if err := assignRolesTx(tx, id, roleNames); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUserByID(id)
}

// SetPassword replaces the password hash for a user.
func (s *Store) SetPassword(userID int64, plainPassword string) error {
	if plainPassword == "" {
		return errors.New("password cannot be empty")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plainPassword), 12)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL
		 WHERE id = ?`, string(hash), userID)
	return err
}

// SetUserRoles replaces the role list of a user.
func (s *Store) SetUserRoles(userID int64, roleNames []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM user_roles WHERE user_id = ?`, userID); err != nil {
		return err
	}
	if err := assignRolesTx(tx, userID, roleNames); err != nil {
		return err
	}
	return tx.Commit()
}

func assignRolesTx(tx *sql.Tx, userID int64, roleNames []string) error {
	for _, n := range roleNames {
		var rid int64
		err := tx.QueryRow(`SELECT id FROM roles WHERE name = ?`, n).Scan(&rid)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
			userID, rid); err != nil {
			return err
		}
	}
	return nil
}

// SetCallsign updates a user's callsign.
func (s *Store) SetCallsign(userID int64, callsign string) error {
	_, err := s.db.Exec(`UPDATE users SET callsign = ? WHERE id = ?`,
		strings.ToUpper(callsign), userID)
	return err
}

// SetDisabled toggles a user's disabled flag.
func (s *Store) SetDisabled(userID int64, disabled bool) error {
	d := 0
	if disabled {
		d = 1
	}
	_, err := s.db.Exec(`UPDATE users SET disabled = ? WHERE id = ?`, d, userID)
	return err
}

// DeleteUser removes a user account.
func (s *Store) DeleteUser(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM users WHERE id = ?`, userID)
	return err
}

// GetUserByID returns a user with roles + computed permissions populated.
func (s *Store) GetUserByID(id int64) (User, error) {
	return s.getUser(`id = ?`, id)
}

// GetUserByUsername returns a user by their (lowercased) username.
func (s *Store) GetUserByUsername(username string) (User, error) {
	return s.getUser(`username = ?`, strings.ToLower(strings.TrimSpace(username)))
}

func (s *Store) getUser(where string, arg interface{}) (User, error) {
	row := s.db.QueryRow(
		`SELECT id, username, callsign, password_hash, helper_token, failed_attempts,
		        locked_until, disabled, created_at, last_activity_at FROM users WHERE `+where, arg)
	var u User
	var lockStr sql.NullString
	var createdStr, lastActStr string
	var disabledInt int
	err := row.Scan(&u.ID, &u.Username, &u.Callsign, &u.PasswordHash, &u.HelperToken,
		&u.FailedAttempts, &lockStr, &disabledInt, &createdStr, &lastActStr)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	if lockStr.Valid && lockStr.String != "" {
		t, _ := time.Parse(time.RFC3339, lockStr.String)
		u.LockedUntil = &t
	}
	u.Disabled = disabledInt != 0
	u.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
	if lastActStr != "" {
		t, _ := time.Parse(time.RFC3339, lastActStr)
		u.LastActivityAt = &t
	}

	roles, perms, err := s.userRolesAndPermissions(u.ID)
	if err != nil {
		return User{}, err
	}
	u.Roles = roles
	u.Permissions = perms
	return u, nil
}

// ListUsers returns every user with roles + permissions populated.
func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query(
		`SELECT id, username, callsign, password_hash, helper_token, failed_attempts,
		        locked_until, disabled, created_at, last_activity_at
		 FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		var lockStr sql.NullString
		var createdStr, lastActStr string
		var disabledInt int
		if err := rows.Scan(&u.ID, &u.Username, &u.Callsign, &u.PasswordHash, &u.HelperToken,
			&u.FailedAttempts, &lockStr, &disabledInt, &createdStr, &lastActStr); err != nil {
			return nil, err
		}
		if lockStr.Valid && lockStr.String != "" {
			t, _ := time.Parse(time.RFC3339, lockStr.String)
			u.LockedUntil = &t
		}
		u.Disabled = disabledInt != 0
		u.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		if lastActStr != "" {
			t, _ := time.Parse(time.RFC3339, lastActStr)
			u.LastActivityAt = &t
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		roles, perms, err := s.userRolesAndPermissions(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Roles = roles
		out[i].Permissions = perms
	}
	return out, nil
}

func (s *Store) userRolesAndPermissions(userID int64) ([]string, []string, error) {
	rows, err := s.db.Query(
		`SELECT r.name, r.permissions FROM roles r
		 JOIN user_roles ur ON ur.role_id = r.id
		 WHERE ur.user_id = ? ORDER BY r.name`, userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	roles := []string{}
	permSet := map[string]struct{}{}
	for rows.Next() {
		var name, perms string
		if err := rows.Scan(&name, &perms); err != nil {
			return nil, nil, err
		}
		roles = append(roles, name)
		for _, p := range strings.Split(perms, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				permSet[p] = struct{}{}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	perms := make([]string, 0, len(permSet))
	for p := range permSet {
		perms = append(perms, p)
	}
	sort.Strings(perms)
	return roles, perms, nil
}

// RecordLoginFailure increments the user's failed counter and, if the
// configured threshold is reached, sets locked_until.  Returns the resulting
// (failedCount, lockedUntil).
func (s *Store) RecordLoginFailure(userID int64, threshold int, lockoutFor time.Duration) (int, *time.Time, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	var failed int
	if err := tx.QueryRow(`SELECT failed_attempts FROM users WHERE id = ?`, userID).Scan(&failed); err != nil {
		return 0, nil, err
	}
	failed++
	var lockedAt *time.Time
	if failed >= threshold {
		t := time.Now().UTC().Add(lockoutFor)
		lockedAt = &t
		if _, err := tx.Exec(
			`UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`,
			failed, t.Format(time.RFC3339), userID); err != nil {
			return 0, nil, err
		}
	} else {
		if _, err := tx.Exec(
			`UPDATE users SET failed_attempts = ? WHERE id = ?`,
			failed, userID); err != nil {
			return 0, nil, err
		}
	}
	return failed, lockedAt, tx.Commit()
}

// ClearLoginFailures resets a user's failure counter and lockout (call on success).
func (s *Store) ClearLoginFailures(userID int64) error {
	_, err := s.db.Exec(
		`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`, userID)
	return err
}

// UnlockUser administratively clears a lockout.
func (s *Store) UnlockUser(userID int64) error { return s.ClearLoginFailures(userID) }

// ----- roles -----

// ListRoles returns every role.
func (s *Store) ListRoles() ([]Role, error) {
	rows, err := s.db.Query(`SELECT id, name, permissions, is_builtin FROM roles ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var r Role
		var perms string
		var bi int
		if err := rows.Scan(&r.ID, &r.Name, &perms, &bi); err != nil {
			return nil, err
		}
		r.IsBuiltin = bi != 0
		for _, p := range strings.Split(perms, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				r.Permissions = append(r.Permissions, p)
			}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRoleByName looks up a role.
func (s *Store) GetRoleByName(name string) (Role, error) {
	row := s.db.QueryRow(`SELECT id, name, permissions, is_builtin FROM roles WHERE name = ?`,
		strings.ToLower(strings.TrimSpace(name)))
	var r Role
	var perms string
	var bi int
	err := row.Scan(&r.ID, &r.Name, &perms, &bi)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	r.IsBuiltin = bi != 0
	for _, p := range strings.Split(perms, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			r.Permissions = append(r.Permissions, p)
		}
	}
	return r, nil
}

// CreateRole adds a new (non-builtin) role.
func (s *Store) CreateRole(name string, permissions []string) (Role, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return Role{}, errors.New("role name required")
	}
	csv := strings.Join(permissions, ",")
	res, err := s.db.Exec(
		`INSERT INTO roles (name, permissions, is_builtin) VALUES (?, ?, 0)`,
		name, csv)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return Role{}, ErrRoleNameTaken
		}
		return Role{}, err
	}
	id, _ := res.LastInsertId()
	return Role{ID: id, Name: name, Permissions: permissions}, nil
}

// UpdateRolePermissions replaces a role's permission list.  The admin role's
// permissions are immutable ("*") and cannot be changed by this call.
func (s *Store) UpdateRolePermissions(roleID int64, permissions []string) error {
	role, err := s.getRoleByID(roleID)
	if err != nil {
		return err
	}
	if role.IsBuiltin && role.Name == "admin" {
		return errors.New("the admin role's permissions cannot be modified")
	}
	csv := strings.Join(permissions, ",")
	_, err = s.db.Exec(`UPDATE roles SET permissions = ? WHERE id = ?`, csv, roleID)
	return err
}

// DeleteRole removes a non-builtin role.
func (s *Store) DeleteRole(roleID int64) error {
	role, err := s.getRoleByID(roleID)
	if err != nil {
		return err
	}
	if role.IsBuiltin {
		return errors.New("built-in roles cannot be deleted")
	}
	_, err = s.db.Exec(`DELETE FROM roles WHERE id = ?`, roleID)
	return err
}

// GetRoleByID looks up a role by its primary key.
func (s *Store) GetRoleByID(id int64) (Role, error) { return s.getRoleByID(id) }

func (s *Store) getRoleByID(id int64) (Role, error) {
	row := s.db.QueryRow(`SELECT id, name, permissions, is_builtin FROM roles WHERE id = ?`, id)
	var r Role
	var perms string
	var bi int
	err := row.Scan(&r.ID, &r.Name, &perms, &bi)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	r.IsBuiltin = bi != 0
	for _, p := range strings.Split(perms, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			r.Permissions = append(r.Permissions, p)
		}
	}
	return r, nil
}

// TouchUserActivity records the current UTC time as last_activity_at for the given user.
func (s *Store) TouchUserActivity(userID int64) error {
	_, err := s.db.Exec(
		`UPDATE users SET last_activity_at = ? WHERE id = ?`,
		time.Now().UTC().Format(time.RFC3339), userID)
	return err
}

// GetUserByHelperToken looks up a user by their personal helper token.
func (s *Store) GetUserByHelperToken(token string) (User, error) {
	if token == "" {
		return User{}, ErrNotFound
	}
	return s.getUser(`helper_token = ?`, token)
}

// RegenerateHelperToken generates a fresh token for the given user, persists it,
// and returns the new value.
func (s *Store) RegenerateHelperToken(userID int64) (string, error) {
	tok := generateHelperToken()
	_, err := s.db.Exec(`UPDATE users SET helper_token = ? WHERE id = ?`, tok, userID)
	if err != nil {
		return "", err
	}
	return tok, nil
}

// CountAdmins returns how many users currently hold the admin role
// (used to prevent removing the last admin).
func (s *Store) CountAdmins() (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM user_roles ur
		 JOIN roles r ON r.id = ur.role_id
		 WHERE r.name = 'admin'`).Scan(&n)
	return n, err
}
