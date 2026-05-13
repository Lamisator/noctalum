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
	CustomFields string    `json:"custom_fields"` // JSON-encoded array of {name,label,type,required,order}
	QSOLayout    string    `json:"qso_layout"`    // JSON-encoded {cols, items:[{key,x,y,w}]} for the New QSO mask
	CreatedAt    time.Time `json:"created_at"`
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
	if err := s.addColumnIfMissing("qsos", "extras", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return fmt.Errorf("migrate qsos extras: %w", err)
	}
	if err := s.addColumnIfMissing("qsos", "contest_id", "INTEGER"); err != nil {
		return fmt.Errorf("migrate qsos contest_id: %w", err)
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS contest_access (
		contest_id INTEGER NOT NULL,
		user_id    INTEGER NOT NULL,
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

// ListContests returns all contests, newest first.
func (s *Store) ListContests() ([]Contest, error) {
	rows, err := s.db.Query(
		`SELECT id, name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, created_at FROM contests ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Contest
	for rows.Next() {
		var c Contest
		var t, bandsStr string
		var priv int
		if err := rows.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &priv, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &t); err != nil {
			return nil, err
		}
		c.Private = priv != 0
		c.Bands = bandsFromString(bandsStr)
		c.CreatedAt, _ = time.Parse(time.RFC3339, t)
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContest returns a single contest by ID.
func (s *Store) GetContest(id int64) (*Contest, error) {
	row := s.db.QueryRow(
		`SELECT id, name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, created_at FROM contests WHERE id = ?`, id)
	var c Contest
	var t, bandsStr string
	var priv int
	if err := row.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &priv, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &t); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrContestNotFound
		}
		return nil, err
	}
	c.Private = priv != 0
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

// DeleteContest removes a contest and its access list from the database.
func (s *Store) DeleteContest(id int64) error {
	if _, err := s.db.Exec(`DELETE FROM contest_access WHERE contest_id = ?`, id); err != nil {
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
