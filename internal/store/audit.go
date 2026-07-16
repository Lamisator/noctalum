package store

import (
	"fmt"
	"strings"
	"time"
)

// AuditLevel classifies the severity of an audit event.
type AuditLevel string

const (
	AuditInfo  AuditLevel = "info"
	AuditWarn  AuditLevel = "warn"
	AuditError AuditLevel = "error"
)

// AuditEntry is one immutable record in the audit log.
type AuditEntry struct {
	ID        int64      `json:"id"`
	Timestamp time.Time  `json:"timestamp"`
	Level     AuditLevel `json:"level"`
	Action    string     `json:"action"`
	Actor     string     `json:"actor"`
	Target    string     `json:"target"`
	Details   string     `json:"details"`
	IP        string     `json:"ip"`
}

// AuditFilter controls which entries ListAuditLogs returns.
type AuditFilter struct {
	Level    string // "" = all
	Action   string // "" = all
	Search   string // matched against actor, target, details
	Since    *time.Time
	Until    *time.Time
	SortBy   string // "timestamp"|"level"|"action"|"actor"|"target"|"ip"
	SortDesc bool
	Limit    int
	Offset   int
}

const auditRetentionDays = 365

func (s *Store) migrateAudit() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS audit_log (
			id        BIGSERIAL PRIMARY KEY,
			timestamp TIMESTAMPTZ NOT NULL,
			level     TEXT NOT NULL,
			action    TEXT NOT NULL,
			actor     TEXT NOT NULL DEFAULT '',
			target    TEXT NOT NULL DEFAULT '',
			details   TEXT NOT NULL DEFAULT '',
			ip        TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_level ON audit_log(level)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate audit: %w", err)
		}
	}
	return nil
}

// InsertAuditLog records one event. Every 100 inserts, entries older than 365
// days are pruned so the table stays bounded without a background goroutine.
func (s *Store) InsertAuditLog(level AuditLevel, action, actor, target, details, ip string) error {
	now := time.Now().UTC()
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO audit_log (timestamp, level, action, actor, target, details, ip)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		now, string(level), action, actor, target, details, ip,
	).Scan(&id)
	if err != nil {
		return err
	}
	if id%100 == 0 {
		cutoff := now.AddDate(0, 0, -auditRetentionDays)
		_, _ = s.db.Exec(`DELETE FROM audit_log WHERE timestamp < $1`, cutoff)
	}
	return nil
}

// ListAuditLogs returns filtered, sorted audit entries and the total match count.
func (s *Store) ListAuditLogs(f AuditFilter) ([]AuditEntry, int, error) {
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
	if f.Action != "" {
		conds = append(conds, "action = "+ph())
		args = append(args, f.Action)
	}
	if f.Search != "" {
		p1, p2, p3 := ph(), ph(), ph()
		conds = append(conds, "(actor ILIKE "+p1+" OR target ILIKE "+p2+" OR details ILIKE "+p3+")")
		pat := "%" + f.Search + "%"
		args = append(args, pat, pat, pat)
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
	if err := s.db.QueryRow("SELECT COUNT(*) FROM audit_log "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	sortCol := "timestamp"
	switch f.SortBy {
	case "level", "action", "actor", "target", "ip":
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
		`SELECT id, timestamp, level, action, actor, target, details, ip
		 FROM audit_log %s ORDER BY %s %s, id DESC LIMIT %s OFFSET %s`,
		where, sortCol, dir, limitPh, offsetPh,
	)
	rows, err := s.db.Query(q, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.Level, &e.Action, &e.Actor, &e.Target, &e.Details, &e.IP); err != nil {
			return nil, 0, err
		}
		e.Timestamp = e.Timestamp.UTC()
		out = append(out, e)
	}
	return out, total, rows.Err()
}
