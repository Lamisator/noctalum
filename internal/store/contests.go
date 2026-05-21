package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrContestNotFound = errors.New("contest not found")

// Contest represents a single ham radio contest event.
type Contest struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	StationCall  string    `json:"station_call"`
	StationID    string    `json:"station_id"` // contest-specific operator/station identifier
	QTH          string    `json:"qth"`        // Maidenhead locator of the station
	Status       string    `json:"status"`     // "open" | "finished"
	Bands        []string  `json:"bands"`      // active bands for this contest
	Objective    string    `json:"objective"`  // markdown text
	Private      bool      `json:"private"`    // owner-only contest
	OwnerUserID  int64     `json:"owner_user_id"`
	CustomFields     string     `json:"custom_fields"`      // JSON-encoded array of {name,label,type,required,order}
	QSOLayout        string     `json:"qso_layout"`         // JSON-encoded {cols, items:[{key,x,y,w}]} for the New QSO mask
	AccessRestricted bool       `json:"access_restricted"`  // when true, only access-listed users / owners / admins can see & enter
	CreatedAt        time.Time  `json:"created_at"`
	LastActivityAt   *time.Time `json:"last_activity_at"` // time of the most recent QSO; nil if no QSOs logged
}

// ContestAccessUser carries the user information returned for contest access list entries.
type ContestAccessUser struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Callsign string `json:"callsign"`
}

func bandsToString(bands []string) string { return strings.Join(bands, ",") }
func bandsFromString(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}

func (s *Store) migrateContests() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS contests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			station_call TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_contests_status ON contests(status)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate contests: %w", err)
		}
	}
	if err := s.addColumnIfMissing("contests", "qth", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests qth: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "bands", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests bands: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "objective", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests objective: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "station_id", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests station_id: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "private", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return fmt.Errorf("migrate contests private: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "owner_user_id", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return fmt.Errorf("migrate contests owner_user_id: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "custom_fields", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests custom_fields: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "qso_layout", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate contests qso_layout: %w", err)
	}
	if err := s.addColumnIfMissing("contests", "access_restricted", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return fmt.Errorf("migrate contests access_restricted: %w", err)
	}
	if err := s.addColumnIfMissing("qsos", "extras", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate qsos extras: %w", err)
	}
	if err := s.addColumnIfMissing("qsos", "contest_id", "INTEGER"); err != nil {
		return fmt.Errorf("migrate qsos contest_id: %w", err)
	}
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS contest_access (
		contest_id INTEGER NOT NULL,
		user_id    INTEGER NOT NULL,
		PRIMARY KEY (contest_id, user_id)
	)`); err != nil {
		return err
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS contest_participants (
		contest_id INTEGER NOT NULL,
		user_id    INTEGER NOT NULL,
		role       TEXT    NOT NULL DEFAULT 'user',
		status     TEXT    NOT NULL DEFAULT 'pending',
		joined_at  TEXT    NOT NULL,
		PRIMARY KEY (contest_id, user_id)
	)`)
	return err
}

func (s *Store) addColumnIfMissing(table, column, colType string) error {
	rows, err := s.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if strings.EqualFold(name, column) {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, colType))
	return err
}

// CreateContest inserts a new contest in 'open' status.
func (s *Store) CreateContest(name, stationCall, qth string, bands []string, objective, stationID string, private bool, ownerUserID int64, customFields, qsoLayout string) (*Contest, error) {
	name = strings.TrimSpace(name)
	stationCall = strings.ToUpper(strings.TrimSpace(stationCall))
	qth = strings.ToUpper(strings.TrimSpace(qth))
	stationID = strings.TrimSpace(stationID)
	priv := 0
	if private {
		priv = 1
	}
	now := time.Now().UTC()
	res, err := s.db.Exec(
		`INSERT INTO contests (name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
		name, stationCall, qth, bandsToString(bands), objective, stationID, priv, ownerUserID, customFields, qsoLayout, now.Format(time.RFC3339),
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, errors.New("contest name already in use")
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Contest{ID: id, Name: name, StationCall: stationCall, QTH: qth, Bands: bands, Objective: objective, Status: "open", StationID: stationID, Private: private, OwnerUserID: ownerUserID, CustomFields: customFields, QSOLayout: qsoLayout, CreatedAt: now}, nil
}

// ListContests returns all contests, newest first, with last QSO activity time.
func (s *Store) ListContests() ([]Contest, error) {
	rows, err := s.db.Query(
		`SELECT c.id, c.name, c.station_call, c.qth, c.bands, c.objective, c.status, c.station_id,
		        c.private, c.owner_user_id, c.custom_fields, c.qso_layout, c.access_restricted, c.created_at,
		        MAX(q.time_utc) AS last_activity_at
		 FROM contests c
		 LEFT JOIN qsos q ON q.contest_id = c.id
		 GROUP BY c.id
		 ORDER BY c.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Contest
	for rows.Next() {
		var c Contest
		var t, bandsStr string
		var priv, ar int
		var lastAct sql.NullString
		if err := rows.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &priv, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &ar, &t, &lastAct); err != nil {
			return nil, err
		}
		c.Private = priv != 0
		c.AccessRestricted = ar != 0
		c.Bands = bandsFromString(bandsStr)
		c.CreatedAt, _ = time.Parse(time.RFC3339, t)
		if lastAct.Valid && lastAct.String != "" {
			la, _ := time.Parse(time.RFC3339, lastAct.String)
			c.LastActivityAt = &la
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContest returns a single contest by ID.
func (s *Store) GetContest(id int64) (*Contest, error) {
	row := s.db.QueryRow(
		`SELECT id, name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, access_restricted, created_at FROM contests WHERE id = ?`, id)
	var c Contest
	var t, bandsStr string
	var priv, ar int
	if err := row.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &priv, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &ar, &t); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrContestNotFound
		}
		return nil, err
	}
	c.Private = priv != 0
	c.AccessRestricted = ar != 0
	c.Bands = bandsFromString(bandsStr)
	c.CreatedAt, _ = time.Parse(time.RFC3339, t)
	return &c, nil
}

// UpdateContest updates name, station_call, qth, bands, objective and status of an existing contest.
func (s *Store) UpdateContest(id int64, name, stationCall, qth, status string, bands []string, objective, stationID, customFields, qsoLayout string) error {
	_, err := s.db.Exec(
		`UPDATE contests SET name = ?, station_call = ?, qth = ?, bands = ?, objective = ?, status = ?, station_id = ?, custom_fields = ?, qso_layout = ? WHERE id = ?`,
		strings.TrimSpace(name), strings.ToUpper(strings.TrimSpace(stationCall)),
		strings.ToUpper(strings.TrimSpace(qth)), bandsToString(bands), objective, status,
		strings.TrimSpace(stationID), customFields, qsoLayout, id,
	)
	return err
}

// DeleteContest removes a contest, its access list, and participants from the database.
func (s *Store) DeleteContest(id int64) error {
	if _, err := s.db.Exec(`DELETE FROM contest_access WHERE contest_id = ?`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM contest_participants WHERE contest_id = ?`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM contests WHERE id = ?`, id)
	return err
}

// GrantContestAccess gives a user access to a private contest.
func (s *Store) GrantContestAccess(contestID, userID int64) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO contest_access (contest_id, user_id) VALUES (?, ?)`, contestID, userID)
	return err
}

// RevokeContestAccess removes a user's access to a private contest.
func (s *Store) RevokeContestAccess(contestID, userID int64) error {
	_, err := s.db.Exec(`DELETE FROM contest_access WHERE contest_id = ? AND user_id = ?`, contestID, userID)
	return err
}

// HasContestAccess returns true if the user has been explicitly granted access.
func (s *Store) HasContestAccess(contestID, userID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM contest_access WHERE contest_id = ? AND user_id = ?`, contestID, userID).Scan(&n)
	return n > 0, err
}

// GetContestAccessList returns all user IDs that have been granted access to a contest.
func (s *Store) GetContestAccessList(contestID int64) ([]int64, error) {
	rows, err := s.db.Query(`SELECT user_id FROM contest_access WHERE contest_id = ?`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}

// GetContestAccessUsers returns users (with username and callsign) granted access to a contest.
func (s *Store) GetContestAccessUsers(contestID int64) ([]ContestAccessUser, error) {
	rows, err := s.db.Query(
		`SELECT u.id, u.username, u.callsign
		 FROM contest_access ca
		 JOIN users u ON u.id = ca.user_id
		 WHERE ca.contest_id = ?
		 ORDER BY u.username`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContestAccessUser
	for rows.Next() {
		var u ContestAccessUser
		if err := rows.Scan(&u.UserID, &u.Username, &u.Callsign); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetContestAccessRestricted enables or disables access restriction for a contest.
func (s *Store) SetContestAccessRestricted(contestID int64, restricted bool) error {
	v := 0
	if restricted {
		v = 1
	}
	_, err := s.db.Exec(`UPDATE contests SET access_restricted = ? WHERE id = ?`, v, contestID)
	return err
}

// GrantContestAccessByUsername resolves a username to a user ID and grants access.
// Returns the resolved user ID on success.
func (s *Store) GrantContestAccessByUsername(contestID int64, username string) (int64, error) {
	u, err := s.GetUserByUsername(username)
	if err != nil {
		return 0, err
	}
	return u.ID, s.GrantContestAccess(contestID, u.ID)
}

// ----- contest participants -----

// ContestParticipant represents a user's participation in a contest.
type ContestParticipant struct {
	ContestID int64     `json:"contest_id"`
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	Callsign  string    `json:"callsign"`
	Role      string    `json:"role"`   // "owner" | "user"
	Status    string    `json:"status"` // "active" | "pending"
	JoinedAt  time.Time `json:"joined_at"`
}

// AddContestParticipant inserts a participant with the given role and status.
func (s *Store) AddContestParticipant(contestID, userID int64, role, status string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO contest_participants (contest_id, user_id, role, status, joined_at) VALUES (?, ?, ?, ?, ?)`,
		contestID, userID, role, status, now,
	)
	return err
}

// RequestContestParticipant inserts the user as a pending participant if not already present.
func (s *Store) RequestContestParticipant(contestID, userID int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO contest_participants (contest_id, user_id, role, status, joined_at) VALUES (?, ?, 'user', 'pending', ?)`,
		contestID, userID, now,
	)
	return err
}

// GetContestParticipants returns all participants for a contest, joined with user info.
func (s *Store) GetContestParticipants(contestID int64) ([]ContestParticipant, error) {
	rows, err := s.db.Query(
		`SELECT cp.contest_id, cp.user_id, u.username, u.callsign, cp.role, cp.status, cp.joined_at
		 FROM contest_participants cp
		 JOIN users u ON u.id = cp.user_id
		 WHERE cp.contest_id = ?
		 ORDER BY cp.role DESC, u.username`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContestParticipant
	for rows.Next() {
		var p ContestParticipant
		var jat string
		if err := rows.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &jat); err != nil {
			return nil, err
		}
		p.JoinedAt, _ = time.Parse(time.RFC3339, jat)
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetContestParticipant returns a single participant record, or nil if not found.
func (s *Store) GetContestParticipant(contestID, userID int64) (*ContestParticipant, error) {
	row := s.db.QueryRow(
		`SELECT cp.contest_id, cp.user_id, u.username, u.callsign, cp.role, cp.status, cp.joined_at
		 FROM contest_participants cp
		 JOIN users u ON u.id = cp.user_id
		 WHERE cp.contest_id = ? AND cp.user_id = ?`, contestID, userID)
	var p ContestParticipant
	var jat string
	if err := row.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &jat); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	p.JoinedAt, _ = time.Parse(time.RFC3339, jat)
	return &p, nil
}

// UpdateContestParticipant changes role and/or status for an existing participant.
func (s *Store) UpdateContestParticipant(contestID, userID int64, role, status string) error {
	_, err := s.db.Exec(
		`UPDATE contest_participants SET role = ?, status = ? WHERE contest_id = ? AND user_id = ?`,
		role, status, contestID, userID,
	)
	return err
}

// RemoveContestParticipant deletes a participant from a contest.
func (s *Store) RemoveContestParticipant(contestID, userID int64) error {
	_, err := s.db.Exec(`DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?`, contestID, userID)
	return err
}

// GetUserParticipations returns all contest participations for a user, keyed by contest ID.
func (s *Store) GetUserParticipations(userID int64) (map[int64]ContestParticipant, error) {
	rows, err := s.db.Query(
		`SELECT cp.contest_id, cp.user_id, u.username, u.callsign, cp.role, cp.status, cp.joined_at
		 FROM contest_participants cp
		 JOIN users u ON u.id = cp.user_id
		 WHERE cp.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]ContestParticipant)
	for rows.Next() {
		var p ContestParticipant
		var jat string
		if err := rows.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &jat); err != nil {
			return nil, err
		}
		p.JoinedAt, _ = time.Parse(time.RFC3339, jat)
		out[p.ContestID] = p
	}
	return out, rows.Err()
}
