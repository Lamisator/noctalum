package store

import (
	"fmt"
	"strings"
	"time"
)

// SysLevel classifies the severity of a system log entry. The values are
// chosen to match the audit log's convention (info/warn/error) so a
// single UI style-sheet can render both tables consistently.
type SysLevel string

const (
	SysDebug SysLevel = "debug"
	SysInfo  SysLevel = "info"
	SysWarn  SysLevel = "warn"
	SysError SysLevel = "error"
)

// SysEntry is one row of the system log.
type SysEntry struct {
	ID        int64     `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Level     SysLevel  `json:"level"`
	Source    string    `json:"source"`
	Message   string    `json:"message"`
}

// SysFilter controls which entries ListSystemLogs returns.
type SysFilter struct {
	Level    string // "" = all
	Source   string // "" = all
	Search   string // matched against source + message
	Since    *time.Time
	Until    *time.Time
	SortBy   string // "timestamp"|"level"|"source"
	SortDesc bool
	Limit    int
	Offset   int
}

const sysLogRetentionDays = 365

func (s *Store) migrateSystemLog() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS system_log (
			id        BIGSERIAL PRIMARY KEY,
			timestamp TIMESTAMPTZ NOT NULL,
			level     TEXT NOT NULL,
			source    TEXT NOT NULL DEFAULT '',
			message   TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_system_log_ts ON system_log(timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_system_log_level ON system_log(level)`,
		`CREATE INDEX IF NOT EXISTS idx_system_log_source ON system_log(source)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate system_log: %w", err)
		}
	}
	return nil
}

// InsertSystemLog appends one row. Every 200 inserts the retention prune
// runs so the table stays bounded without a background goroutine; the
// audit log uses the same trick.
//
// Errors are returned rather than swallowed so callers that care (e.g.
// tests) can inspect them; the sysLog helper on the server discards
// errors after logging them to stderr so a broken log write never
// prevents the primary work from completing.
func (s *Store) InsertSystemLog(level SysLevel, source, message string) error {
	now := time.Now().UTC()
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO system_log (timestamp, level, source, message)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		now, string(level), cleanStr(source), cleanStr(message),
	).Scan(&id)
	if err != nil {
		return err
	}
	if id%200 == 0 {
		cutoff := now.AddDate(0, 0, -sysLogRetentionDays)
		_, _ = s.db.Exec(`DELETE FROM system_log WHERE timestamp < $1`, cutoff)
	}
	return nil
}

// ListSystemLogs returns filtered, sorted system-log entries and the
// total match count. The 500-row hard cap mirrors ListAuditLogs so the
// UI cannot accidentally request a payload big enough to OOM either
// side.
func (s *Store) ListSystemLogs(f SysFilter) ([]SysEntry, int, error) {
	var conds []string
	var args []interface{}
	next := 1
	ph := func() string {
		p := fmt.Sprintf("$%d", next)
		next++
		return p
	}

	if f.Level != "" {
		conds = append(conds, "level = "+ph())
		args = append(args, f.Level)
	}
	if f.Source != "" {
		conds = append(conds, "source = "+ph())
		args = append(args, f.Source)
	}
	if f.Search != "" {
		p1, p2 := ph(), ph()
		conds = append(conds, "(source ILIKE "+p1+" OR message ILIKE "+p2+")")
		pat := "%" + f.Search + "%"
		args = append(args, pat, pat)
	}
	if f.Since != nil {
		conds = append(conds, "timestamp >= "+ph())
		args = append(args, f.Since.UTC())
	}
	if f.Until != nil {
		conds = append(conds, "timestamp <= "+ph())
		args = append(args, f.Until.UTC())
	}

	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM system_log "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	sortCol := "timestamp"
	switch f.SortBy {
	case "level", "source":
		sortCol = f.SortBy
	}
	dir := "DESC"
	if !f.SortDesc {
		dir = "ASC"
	}

	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	limitPh := ph()
	offsetPh := ph()
	q := fmt.Sprintf(
		`SELECT id, timestamp, level, source, message
		 FROM system_log %s ORDER BY %s %s, id DESC LIMIT %s OFFSET %s`,
		where, sortCol, dir, limitPh, offsetPh,
	)
	rows, err := s.db.Query(q, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []SysEntry
	for rows.Next() {
		var e SysEntry
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.Level, &e.Source, &e.Message); err != nil {
			return nil, 0, err
		}
		e.Timestamp = e.Timestamp.UTC()
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// SystemLogSources returns the distinct source labels currently present
// in the table (used to populate the filter dropdown). Capped at 200
// entries — realistically we have well under a dozen but the cap keeps
// a pathological deployment from ever returning an unbounded list.
func (s *Store) SystemLogSources() ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT source FROM system_log WHERE source <> '' ORDER BY source LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var src string
		if err := rows.Scan(&src); err != nil {
			return nil, err
		}
		out = append(out, src)
	}
	return out, rows.Err()
}
