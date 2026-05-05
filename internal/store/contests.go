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
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	StationCall string    `json:"station_call"`
	Status      string    `json:"status"` // "open" | "finished"
	CreatedAt   time.Time `json:"created_at"`
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
	return s.addColumnIfMissing("qsos", "contest_id", "INTEGER")
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
func (s *Store) CreateContest(name, stationCall string) (*Contest, error) {
	name = strings.TrimSpace(name)
	stationCall = strings.ToUpper(strings.TrimSpace(stationCall))
	now := time.Now().UTC()
	res, err := s.db.Exec(
		`INSERT INTO contests (name, station_call, status, created_at) VALUES (?, ?, 'open', ?)`,
		name, stationCall, now.Format(time.RFC3339),
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, errors.New("contest name already in use")
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Contest{ID: id, Name: name, StationCall: stationCall, Status: "open", CreatedAt: now}, nil
}

// ListContests returns all contests, newest first.
func (s *Store) ListContests() ([]Contest, error) {
	rows, err := s.db.Query(
		`SELECT id, name, station_call, status, created_at FROM contests ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Contest
	for rows.Next() {
		var c Contest
		var t string
		if err := rows.Scan(&c.ID, &c.Name, &c.StationCall, &c.Status, &t); err != nil {
			return nil, err
		}
		c.CreatedAt, _ = time.Parse(time.RFC3339, t)
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContest returns a single contest by ID.
func (s *Store) GetContest(id int64) (*Contest, error) {
	row := s.db.QueryRow(
		`SELECT id, name, station_call, status, created_at FROM contests WHERE id = ?`, id)
	var c Contest
	var t string
	if err := row.Scan(&c.ID, &c.Name, &c.StationCall, &c.Status, &t); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrContestNotFound
		}
		return nil, err
	}
	c.CreatedAt, _ = time.Parse(time.RFC3339, t)
	return &c, nil
}

// UpdateContest updates name, station_call and status of an existing contest.
func (s *Store) UpdateContest(id int64, name, stationCall, status string) error {
	_, err := s.db.Exec(
		`UPDATE contests SET name = ?, station_call = ?, status = ? WHERE id = ?`,
		strings.TrimSpace(name), strings.ToUpper(strings.TrimSpace(stationCall)), status, id,
	)
	return err
}
