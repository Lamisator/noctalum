// Command sqlite-to-pg migrates a Noctalum SQLite database into a fresh
// PostgreSQL schema produced by internal/store's migrate() routines.
//
// Design notes:
//
//   - One big transaction on the Postgres side. At Noctalum's data
//     volume (well under 100k rows total, ~40 MB of table data) the
//     complexity budget for chunked / resumable migration isn't
//     worth it — a failed run rolls back cleanly and can be retried.
//
//   - Load order respects foreign-key parents-first: users, roles,
//     contests before their dependents.
//
//   - Postgres is expected to be *empty* — every migrated table must
//     have COUNT(*)=0 before we load. --force overrides.
//
//   - IDs are preserved. After every table with a BIGSERIAL PK we
//     run SELECT setval(pg_get_serial_sequence(...), MAX(id)) so
//     subsequent INSERTs from the app don't collide.
//
//   - Timestamp parsing is strict. Most SQLite columns hold RFC3339
//     strings; cluster_spots.created_at is the odd one out and uses
//     SQLite's `datetime('now')` format ("2006-01-02 15:04:05" with
//     no timezone). parseTS handles both, empty string maps to zero
//     Time, and anything else aborts the migration.
//
//   - Booleans stored as INTEGER 0/1 in SQLite are converted to real
//     BOOLEAN in Postgres via the intBool() helper.
//
//   - Dry-run reads everything through the transform layer (so type
//     errors surface) but does not commit — useful for validating a
//     backup before an actual cutover.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/noctalum/noctalum/internal/store"
)

func main() {
	sqlitePath := flag.String("sqlite", "", "path to the SQLite backup file to read from")
	pgDSN := flag.String("pg", "", "PostgreSQL DSN to write to (postgres://user:pass@host:port/db?sslmode=disable)")
	dryRun := flag.Bool("dry-run", false, "read+transform every row but do not commit the transaction")
	force := flag.Bool("force", false, "load into a non-empty Postgres schema (default is to refuse)")
	flag.Parse()

	if *sqlitePath == "" || *pgDSN == "" {
		fmt.Fprintln(os.Stderr, "usage: sqlite-to-pg -sqlite=PATH -pg=DSN [-dry-run] [-force]")
		os.Exit(2)
	}

	// SQLite is opened in read-only mode via query parameters so a
	// stray write path can't corrupt the backup file mid-migration.
	src, err := sql.Open("sqlite", *sqlitePath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatalf("open sqlite: %v", err)
	}
	defer src.Close()
	if err := src.Ping(); err != nil {
		log.Fatalf("ping sqlite: %v", err)
	}

	// Open via store.Open() first so the app's own migrate() creates
	// the schema. This lets a fresh DB be migrated with a single
	// command instead of "start the app once, kill it, run this."
	st, err := store.Open(*pgDSN)
	if err != nil {
		log.Fatalf("create schema via store.Open: %v", err)
	}
	// Close it — we'll drive the migration through a raw *sql.DB
	// handle so we can wrap everything in one transaction.
	_ = st.Close()

	dst, err := sql.Open("pgx", *pgDSN)
	if err != nil {
		log.Fatalf("open postgres: %v", err)
	}
	defer dst.Close()
	if err := dst.Ping(); err != nil {
		log.Fatalf("ping postgres: %v", err)
	}

	if err := preflight(dst, *force); err != nil {
		log.Fatalf("preflight: %v", err)
	}

	tx, err := dst.Begin()
	if err != nil {
		log.Fatalf("begin tx: %v", err)
	}
	// Defer a rollback: any early return (error or dry-run) will land
	// here. Commit below cancels it on the happy path.
	defer tx.Rollback()

	m := &migrator{src: src, tx: tx, counts: map[string]int{}}

	// Order matters — see the package doc comment.
	steps := []func() error{
		m.migrateSettings,
		m.migrateDummyRigs,
		m.migrateCallsignCache,
		m.migrateClusterSpots,
		m.migrateRoles,
		m.migrateUsers,
		m.migrateUserRoles,
		m.migrateContests,
		m.migrateContestAccess,
		m.migrateContestParticipants,
		m.migrateContestShares,
		m.migrateQSOs,
		m.migrateQSOStashes,
		m.migrateChatMessages,
		m.migrateAuditLog,
		m.migrateFeatureRequests,
		m.migrateSessions,
		m.migrateWebauthnCredentials,
		m.migrateWebauthnSessions,
		m.migrateCallsignRequests,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			log.Fatalf("migration failed: %v", err)
		}
	}

	// Reset every BIGSERIAL sequence to MAX(id) so the app's next
	// INSERT gets MAX(id)+1 and doesn't collide with a migrated row.
	// Composite-PK / TEXT-PK tables don't need this.
	if err := m.resetSequences(); err != nil {
		log.Fatalf("reset sequences: %v", err)
	}

	if *dryRun {
		log.Println("dry-run: rolling back — no rows written")
	} else {
		if err := tx.Commit(); err != nil {
			log.Fatalf("commit: %v", err)
		}
		log.Println("commit: OK")
	}

	total := 0
	log.Println("row counts:")
	for _, name := range m.tables {
		n := m.counts[name]
		total += n
		log.Printf("  %-24s %8d", name, n)
	}
	log.Printf("  %-24s %8d", "TOTAL", total)
}

// preflight verifies the Postgres side is either empty or the caller
// passed --force. Refusing to load into a populated DB is deliberately
// paranoid: the migration overwrites nothing, so a partial re-run would
// silently duplicate rows.
func preflight(dst *sql.DB, force bool) error {
	tables := []string{
		"settings", "dummy_rigs", "callsign_cache", "cluster_spots",
		"roles", "users", "user_roles",
		"contests", "contest_access", "contest_participants", "contest_shares",
		"qsos", "qso_stashes", "chat_messages", "audit_log",
		"feature_requests", "sessions",
		"webauthn_credentials", "webauthn_sessions",
		"callsign_requests",
	}
	var populated []string
	for _, t := range tables {
		var n int
		if err := dst.QueryRow(`SELECT COUNT(*) FROM ` + t).Scan(&n); err != nil {
			return fmt.Errorf("count %s: %w (has the schema been created by the app yet?)", t, err)
		}
		if n > 0 {
			populated = append(populated, fmt.Sprintf("%s=%d", t, n))
		}
	}
	if len(populated) > 0 && !force {
		return fmt.Errorf("Postgres schema is not empty (%s) — re-run with --force to load anyway", strings.Join(populated, ", "))
	}
	return nil
}

// migrator tracks the shared handles + per-table row counts so the
// step functions can stay small and free of plumbing.
type migrator struct {
	src    *sql.DB
	tx     *sql.Tx
	counts map[string]int
	tables []string // load order, for the final summary
}

func (m *migrator) count(name string, n int) {
	m.counts[name] = n
	m.tables = append(m.tables, name)
}

// exec wraps tx.Exec with an implicit UTF-8 sanitiser on every string
// argument. SQLite is byte-based and happily stored data that isn't
// valid UTF-8 (e.g. DX-cluster comments containing Latin-1 accented
// characters from European spotters). Postgres rejects any non-UTF-8
// byte with SQLSTATE 22021 and aborts the whole transaction — so we
// strip invalid sequences and NULs on the way through rather than
// hunting down every affected column.
func (m *migrator) exec(query string, args ...any) error {
	for i, a := range args {
		if s, ok := a.(string); ok {
			args[i] = cleanStr(s)
		}
	}
	_, err := m.tx.Exec(query, args...)
	return err
}

// cleanStr returns s with any invalid UTF-8 sequences dropped and any
// embedded NUL bytes removed. Fast-path returns the input untouched
// when it's already valid so the common case allocates nothing.
func cleanStr(s string) string {
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		return s
	}
	s = strings.ToValidUTF8(s, "")
	return strings.ReplaceAll(s, "\x00", "")
}

// ----- helpers -----

// parseTS accepts either RFC3339 (the format almost all timestamp
// columns use), SQLite's default datetime() output
// ("2006-01-02 15:04:05" with no TZ) used by cluster_spots.created_at,
// or a bare Unix epoch (all digits — a handful of legacy
// feature_requests rows have this form from an early code path that
// wrote strconv.FormatInt(unix, 10) instead of RFC3339).
// Empty string maps to zero Time — callers decide whether to treat it
// as NULL or reject it.
func parseTS(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		// SQLite's datetime('now') is UTC by convention.
		return t.UTC(), nil
	}
	// All-digit fallback for legacy Unix-epoch strings. 10-digit
	// seconds and 13-digit milliseconds are both plausibly current;
	// anything shorter is likely mis-parsed data and we reject.
	if allDigits(s) && (len(s) == 10 || len(s) == 13) {
		unix, err := parseInt64(s)
		if err == nil {
			if len(s) == 13 {
				return time.UnixMilli(unix).UTC(), nil
			}
			return time.Unix(unix, 0).UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised timestamp format: %q", s)
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseInt64(s string) (int64, error) {
	var n int64
	for _, r := range s {
		n = n*10 + int64(r-'0')
	}
	return n, nil
}

// intBool converts SQLite's 0/1 int booleans to a Go bool. Anything
// other than 0 or 1 aborts the migration since it likely means we've
// mis-read a column.
func intBool(n int) (bool, error) {
	switch n {
	case 0:
		return false, nil
	case 1:
		return true, nil
	default:
		return false, fmt.Errorf("unexpected boolean value: %d", n)
	}
}

// nullTS is parseTS for nullable timestamp columns. An empty or NULL
// source becomes sql.NullTime{Valid: false}.
func nullTS(s sql.NullString) (sql.NullTime, error) {
	if !s.Valid || s.String == "" {
		return sql.NullTime{}, nil
	}
	t, err := parseTS(s.String)
	if err != nil {
		return sql.NullTime{}, err
	}
	return sql.NullTime{Time: t, Valid: true}, nil
}

// ----- per-table migrations -----

func (m *migrator) migrateSettings() error {
	rows, err := m.src.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return err
		}
		if err := m.exec(`INSERT INTO settings(key, value) VALUES ($1, $2)`, k, v); err != nil {
			return fmt.Errorf("settings %q: %w", k, err)
		}
		n++
	}
	m.count("settings", n)
	return rows.Err()
}

func (m *migrator) migrateDummyRigs() error {
	rows, err := m.src.Query(`SELECT name, default_freq_hz FROM dummy_rigs`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var name string
		var freq int64
		if err := rows.Scan(&name, &freq); err != nil {
			return err
		}
		if err := m.exec(`INSERT INTO dummy_rigs(name, default_freq_hz) VALUES ($1, $2)`, name, freq); err != nil {
			return fmt.Errorf("dummy_rigs %q: %w", name, err)
		}
		n++
	}
	m.count("dummy_rigs", n)
	return rows.Err()
}

func (m *migrator) migrateCallsignCache() error {
	rows, err := m.src.Query(`SELECT callsign, dok, updated_at FROM callsign_cache`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var call, dok, updated string
		if err := rows.Scan(&call, &dok, &updated); err != nil {
			return err
		}
		ts, err := parseTS(updated)
		if err != nil {
			return fmt.Errorf("callsign_cache %q updated_at: %w", call, err)
		}
		if ts.IsZero() {
			ts = time.Now().UTC()
		}
		if err := m.exec(`INSERT INTO callsign_cache(callsign, dok, updated_at) VALUES ($1, $2, $3)`, call, dok, ts); err != nil {
			return fmt.Errorf("callsign_cache %q: %w", call, err)
		}
		n++
	}
	m.count("callsign_cache", n)
	return rows.Err()
}

func (m *migrator) migrateClusterSpots() error {
	rows, err := m.src.Query(`SELECT id, time_str, dx, freq, band, mode, comment, spotter, created_at FROM cluster_spots ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var timeStr, dx, freq, band, mode, comment, spotter, createdAt string
		if err := rows.Scan(&id, &timeStr, &dx, &freq, &band, &mode, &comment, &spotter, &createdAt); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil {
			return fmt.Errorf("cluster_spots id=%d created_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO cluster_spots(id, time_str, dx, freq, band, mode, comment, spotter, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			id, timeStr, dx, freq, band, mode, comment, spotter, ts,
		); err != nil {
			return fmt.Errorf("cluster_spots id=%d: %w", id, err)
		}
		n++
	}
	m.count("cluster_spots", n)
	return rows.Err()
}

func (m *migrator) migrateRoles() error {
	rows, err := m.src.Query(`SELECT id, name, permissions, is_builtin FROM roles ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var name, perms string
		var isBuiltin int
		if err := rows.Scan(&id, &name, &perms, &isBuiltin); err != nil {
			return err
		}
		bi, err := intBool(isBuiltin)
		if err != nil {
			return fmt.Errorf("roles id=%d is_builtin: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO roles(id, name, permissions, is_builtin) VALUES ($1, $2, $3, $4)`,
			id, name, perms, bi,
		); err != nil {
			return fmt.Errorf("roles id=%d: %w", id, err)
		}
		n++
	}
	m.count("roles", n)
	return rows.Err()
}

func (m *migrator) migrateUsers() error {
	rows, err := m.src.Query(
		`SELECT id, username, callsign, password_hash, helper_token, failed_attempts,
		        locked_until, disabled, created_at, last_activity_at, language, last_seen_version, time_input_mode, theme
		 FROM users ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var username, callsign, passwordHash, helperToken string
		var failedAttempts int
		var lockedUntil sql.NullString
		var disabled int
		var createdAt string
		var lastActivityAt, language, lastSeenVersion, timeInputMode, theme string
		if err := rows.Scan(&id, &username, &callsign, &passwordHash, &helperToken, &failedAttempts,
			&lockedUntil, &disabled, &createdAt, &lastActivityAt, &language, &lastSeenVersion, &timeInputMode, &theme); err != nil {
			return err
		}
		created, err := parseTS(createdAt)
		if err != nil || created.IsZero() {
			return fmt.Errorf("users id=%d created_at: %w", id, err)
		}
		locked, err := nullTS(lockedUntil)
		if err != nil {
			return fmt.Errorf("users id=%d locked_until: %w", id, err)
		}
		// last_activity_at is stored as NOT NULL DEFAULT '' in SQLite;
		// the new schema is nullable TIMESTAMPTZ so empty maps to NULL.
		lastAct := sql.NullTime{}
		if lastActivityAt != "" {
			t, err := parseTS(lastActivityAt)
			if err != nil {
				return fmt.Errorf("users id=%d last_activity_at: %w", id, err)
			}
			lastAct = sql.NullTime{Time: t, Valid: true}
		}
		dis, err := intBool(disabled)
		if err != nil {
			return fmt.Errorf("users id=%d disabled: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO users(id, username, callsign, password_hash, helper_token,
			                   failed_attempts, locked_until, disabled, created_at,
			                   last_activity_at, language, last_seen_version, time_input_mode, theme)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			id, username, callsign, passwordHash, helperToken, failedAttempts, locked, dis, created,
			lastAct, language, lastSeenVersion, timeInputMode, theme,
		); err != nil {
			return fmt.Errorf("users id=%d: %w", id, err)
		}
		n++
	}
	m.count("users", n)
	return rows.Err()
}

func (m *migrator) migrateUserRoles() error {
	rows, err := m.src.Query(`SELECT user_id, role_id FROM user_roles`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var uid, rid int64
		if err := rows.Scan(&uid, &rid); err != nil {
			return err
		}
		if err := m.exec(`INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)`, uid, rid); err != nil {
			return fmt.Errorf("user_roles user=%d role=%d: %w", uid, rid, err)
		}
		n++
	}
	m.count("user_roles", n)
	return rows.Err()
}

func (m *migrator) migrateContests() error {
	rows, err := m.src.Query(
		`SELECT id, name, station_call, qth, bands, objective, status, station_id,
		        private, owner_user_id, custom_fields, qso_layout, log_columns,
		        access_restricted, nr_padded, stash_expiry_minutes, freq_unit, created_at
		 FROM contests ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, ownerID, stashExpiry int64
		var name, stationCall, qth, bands, objective, status, stationID, customFields, qsoLayout, logColumns, freqUnit, createdAt string
		var priv, accessRestricted, nrPadded int
		if err := rows.Scan(&id, &name, &stationCall, &qth, &bands, &objective, &status, &stationID,
			&priv, &ownerID, &customFields, &qsoLayout, &logColumns,
			&accessRestricted, &nrPadded, &stashExpiry, &freqUnit, &createdAt); err != nil {
			return err
		}
		created, err := parseTS(createdAt)
		if err != nil || created.IsZero() {
			return fmt.Errorf("contests id=%d created_at: %w", id, err)
		}
		p, err := intBool(priv)
		if err != nil {
			return fmt.Errorf("contests id=%d private: %w", id, err)
		}
		ar, err := intBool(accessRestricted)
		if err != nil {
			return fmt.Errorf("contests id=%d access_restricted: %w", id, err)
		}
		nrp, err := intBool(nrPadded)
		if err != nil {
			return fmt.Errorf("contests id=%d nr_padded: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO contests(id, name, station_call, qth, bands, objective, status, station_id,
			                       private, owner_user_id, custom_fields, qso_layout, log_columns,
			                       access_restricted, nr_padded, stash_expiry_minutes, freq_unit, created_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			id, name, stationCall, qth, bands, objective, status, stationID,
			p, ownerID, customFields, qsoLayout, logColumns, ar, nrp, stashExpiry, freqUnit, created,
		); err != nil {
			return fmt.Errorf("contests id=%d: %w", id, err)
		}
		n++
	}
	m.count("contests", n)
	return rows.Err()
}

func (m *migrator) migrateContestAccess() error {
	rows, err := m.src.Query(`SELECT contest_id, user_id FROM contest_access`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var cid, uid int64
		if err := rows.Scan(&cid, &uid); err != nil {
			return err
		}
		if err := m.exec(`INSERT INTO contest_access(contest_id, user_id) VALUES ($1, $2)`, cid, uid); err != nil {
			return fmt.Errorf("contest_access contest=%d user=%d: %w", cid, uid, err)
		}
		n++
	}
	m.count("contest_access", n)
	return rows.Err()
}

func (m *migrator) migrateContestParticipants() error {
	rows, err := m.src.Query(`SELECT contest_id, user_id, role, status, joined_at FROM contest_participants`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var cid, uid int64
		var role, status, joinedAt string
		if err := rows.Scan(&cid, &uid, &role, &status, &joinedAt); err != nil {
			return err
		}
		ts, err := parseTS(joinedAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("contest_participants contest=%d user=%d joined_at: %w", cid, uid, err)
		}
		if err := m.exec(
			`INSERT INTO contest_participants(contest_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,$4,$5)`,
			cid, uid, role, status, ts,
		); err != nil {
			return fmt.Errorf("contest_participants contest=%d user=%d: %w", cid, uid, err)
		}
		n++
	}
	m.count("contest_participants", n)
	return rows.Err()
}

func (m *migrator) migrateContestShares() error {
	rows, err := m.src.Query(`SELECT token, contest_id, owner_user_id, source_name, payload, created_at FROM contest_shares`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var token, sourceName, payload, createdAt string
		var contestID, ownerID int64
		if err := rows.Scan(&token, &contestID, &ownerID, &sourceName, &payload, &createdAt); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("contest_shares token=%s created_at: %w", token, err)
		}
		if err := m.exec(
			`INSERT INTO contest_shares(token, contest_id, owner_user_id, source_name, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
			token, contestID, ownerID, sourceName, payload, ts,
		); err != nil {
			return fmt.Errorf("contest_shares token=%s: %w", token, err)
		}
		n++
	}
	m.count("contest_shares", n)
	return rows.Err()
}

func (m *migrator) migrateQSOs() error {
	rows, err := m.src.Query(
		`SELECT id, contest_id, time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
		        nr_sent, nr_received, dok, locator, itu_zone, cq_zone, lighthouse,
		        operator, station_call, notes, contest_name, extras
		 FROM qsos ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var contestID sql.NullInt64
		var timeUTC, callsign, name, band, mode, rstSent, rstRecv string
		var freqHz int64
		var nrSent, nrRecv int
		var dok, locator, ituZone, cqZone, lighthouse, operator, stationCall, notes, contestName, extras string
		if err := rows.Scan(&id, &contestID, &timeUTC, &callsign, &name, &band, &freqHz, &mode,
			&rstSent, &rstRecv, &nrSent, &nrRecv, &dok, &locator, &ituZone, &cqZone, &lighthouse,
			&operator, &stationCall, &notes, &contestName, &extras); err != nil {
			return err
		}
		ts, err := parseTS(timeUTC)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("qsos id=%d time_utc: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO qsos(id, contest_id, time_utc, callsign, name, band, freq_hz, mode, rst_sent, rst_received,
			                  nr_sent, nr_received, dok, locator, itu_zone, cq_zone, lighthouse,
			                  operator, station_call, notes, contest_name, extras)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
			id, contestID, ts, callsign, name, band, freqHz, mode, rstSent, rstRecv,
			nrSent, nrRecv, dok, locator, ituZone, cqZone, lighthouse,
			operator, stationCall, notes, contestName, extras,
		); err != nil {
			return fmt.Errorf("qsos id=%d: %w", id, err)
		}
		n++
	}
	m.count("qsos", n)
	return rows.Err()
}

func (m *migrator) migrateQSOStashes() error {
	rows, err := m.src.Query(
		`SELECT id, contest_id, user_id, created_at, callsign, name, rst_sent, rst_received,
		        nr_received, nr_sent, mode, band, freq_hz, dok, locator, itu_zone, cq_zone,
		        notes, lighthouse, utc_time, extras
		 FROM qso_stashes ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, contestID, userID, freqHz, nrRecv, nrSent int64
		var createdAt, callsign, name, rstSent, rstRecv, mode, band, dok, locator, itu, cq, notes, lighthouse, utcTime, extras string
		if err := rows.Scan(&id, &contestID, &userID, &createdAt, &callsign, &name, &rstSent, &rstRecv,
			&nrRecv, &nrSent, &mode, &band, &freqHz, &dok, &locator, &itu, &cq, &notes, &lighthouse, &utcTime, &extras); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("qso_stashes id=%d created_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO qso_stashes(id, contest_id, user_id, created_at, callsign, name, rst_sent, rst_received,
			                          nr_received, nr_sent, mode, band, freq_hz, dok, locator, itu_zone, cq_zone,
			                          notes, lighthouse, utc_time, extras)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
			id, contestID, userID, ts, callsign, name, rstSent, rstRecv,
			nrRecv, nrSent, mode, band, freqHz, dok, locator, itu, cq, notes, lighthouse, utcTime, extras,
		); err != nil {
			return fmt.Errorf("qso_stashes id=%d: %w", id, err)
		}
		n++
	}
	m.count("qso_stashes", n)
	return rows.Err()
}

func (m *migrator) migrateChatMessages() error {
	rows, err := m.src.Query(`SELECT id, contest_id, from_call, username, text, created_at FROM chat_messages ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, contestID int64
		var fromCall, username, text, createdAt string
		if err := rows.Scan(&id, &contestID, &fromCall, &username, &text, &createdAt); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("chat_messages id=%d created_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO chat_messages(id, contest_id, from_call, username, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
			id, contestID, fromCall, username, text, ts,
		); err != nil {
			return fmt.Errorf("chat_messages id=%d: %w", id, err)
		}
		n++
	}
	m.count("chat_messages", n)
	return rows.Err()
}

func (m *migrator) migrateAuditLog() error {
	rows, err := m.src.Query(`SELECT id, timestamp, level, action, actor, target, details, ip FROM audit_log ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var timestamp, level, action, actor, target, details, ip string
		if err := rows.Scan(&id, &timestamp, &level, &action, &actor, &target, &details, &ip); err != nil {
			return err
		}
		ts, err := parseTS(timestamp)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("audit_log id=%d timestamp: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO audit_log(id, timestamp, level, action, actor, target, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			id, ts, level, action, actor, target, details, ip,
		); err != nil {
			return fmt.Errorf("audit_log id=%d: %w", id, err)
		}
		n++
	}
	m.count("audit_log", n)
	return rows.Err()
}

func (m *migrator) migrateFeatureRequests() error {
	rows, err := m.src.Query(`SELECT id, from_user, text, status, admin_comment, created_at FROM feature_requests ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var fromUser, text, status, adminComment, createdAt string
		if err := rows.Scan(&id, &fromUser, &text, &status, &adminComment, &createdAt); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("feature_requests id=%d created_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO feature_requests(id, from_user, text, status, admin_comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
			id, fromUser, text, status, adminComment, ts,
		); err != nil {
			return fmt.Errorf("feature_requests id=%d: %w", id, err)
		}
		n++
	}
	m.count("feature_requests", n)
	return rows.Err()
}

func (m *migrator) migrateSessions() error {
	rows, err := m.src.Query(`SELECT id, user_id, csrf_token, created_at, last_seen, expires_at FROM sessions`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, csrfToken string
		var userID int64
		var createdAt, lastSeen, expiresAt string
		if err := rows.Scan(&id, &userID, &csrfToken, &createdAt, &lastSeen, &expiresAt); err != nil {
			return err
		}
		ct, err := parseTS(createdAt)
		if err != nil || ct.IsZero() {
			return fmt.Errorf("sessions id=%s created_at: %w", id, err)
		}
		ls, err := parseTS(lastSeen)
		if err != nil || ls.IsZero() {
			return fmt.Errorf("sessions id=%s last_seen: %w", id, err)
		}
		ex, err := parseTS(expiresAt)
		if err != nil || ex.IsZero() {
			return fmt.Errorf("sessions id=%s expires_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO sessions(id, user_id, csrf_token, created_at, last_seen, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
			id, userID, csrfToken, ct, ls, ex,
		); err != nil {
			return fmt.Errorf("sessions id=%s: %w", id, err)
		}
		n++
	}
	m.count("sessions", n)
	return rows.Err()
}

func (m *migrator) migrateWebauthnCredentials() error {
	rows, err := m.src.Query(`SELECT id, user_id, name, data, created_at FROM webauthn_credentials`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, name, data, createdAt string
		var userID int64
		if err := rows.Scan(&id, &userID, &name, &data, &createdAt); err != nil {
			return err
		}
		ts, err := parseTS(createdAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("webauthn_credentials id=%s created_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO webauthn_credentials(id, user_id, name, data, created_at) VALUES ($1,$2,$3,$4,$5)`,
			id, userID, name, data, ts,
		); err != nil {
			return fmt.Errorf("webauthn_credentials id=%s: %w", id, err)
		}
		n++
	}
	m.count("webauthn_credentials", n)
	return rows.Err()
}

func (m *migrator) migrateWebauthnSessions() error {
	rows, err := m.src.Query(`SELECT id, data, expires_at FROM webauthn_sessions`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, data, expiresAt string
		if err := rows.Scan(&id, &data, &expiresAt); err != nil {
			return err
		}
		ts, err := parseTS(expiresAt)
		if err != nil || ts.IsZero() {
			return fmt.Errorf("webauthn_sessions id=%s expires_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO webauthn_sessions(id, data, expires_at) VALUES ($1,$2,$3)`,
			id, data, ts,
		); err != nil {
			return fmt.Errorf("webauthn_sessions id=%s: %w", id, err)
		}
		n++
	}
	m.count("webauthn_sessions", n)
	return rows.Err()
}

func (m *migrator) migrateCallsignRequests() error {
	rows, err := m.src.Query(
		`SELECT id, user_id, current_callsign, requested_callsign, proof_filename, proof_mime, proof_size,
		        status, admin_note, created_at, decided_by, decided_at
		 FROM callsign_requests ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, userID, proofSize int64
		var currentCall, requestedCall, proofFilename, proofMime, status, adminNote, createdAt string
		var decidedBy sql.NullInt64
		var decidedAt sql.NullString
		if err := rows.Scan(&id, &userID, &currentCall, &requestedCall, &proofFilename, &proofMime, &proofSize,
			&status, &adminNote, &createdAt, &decidedBy, &decidedAt); err != nil {
			return err
		}
		created, err := parseTS(createdAt)
		if err != nil || created.IsZero() {
			return fmt.Errorf("callsign_requests id=%d created_at: %w", id, err)
		}
		decided, err := nullTS(decidedAt)
		if err != nil {
			return fmt.Errorf("callsign_requests id=%d decided_at: %w", id, err)
		}
		if err := m.exec(
			`INSERT INTO callsign_requests(id, user_id, current_callsign, requested_callsign, proof_filename, proof_mime, proof_size,
			                                status, admin_note, created_at, decided_by, decided_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			id, userID, currentCall, requestedCall, proofFilename, proofMime, proofSize,
			status, adminNote, created, decidedBy, decided,
		); err != nil {
			return fmt.Errorf("callsign_requests id=%d: %w", id, err)
		}
		n++
	}
	m.count("callsign_requests", n)
	return rows.Err()
}

// resetSequences walks every BIGSERIAL-backed table and advances its
// sequence past the max migrated id, so the app's next INSERT does not
// collide. Tables with composite / TEXT primary keys are skipped.
func (m *migrator) resetSequences() error {
	tables := []string{
		"cluster_spots", "roles", "users", "contests", "qsos",
		"qso_stashes", "chat_messages", "audit_log", "feature_requests",
		"callsign_requests",
	}
	for _, t := range tables {
		// setval() on an empty table is a no-op that would leave the
		// sequence's next value at whatever the default was — but the
		// migrated MAX(id) coming back as NULL is what we want to
		// short-circuit; COALESCE handles that safely.
		var next sql.NullInt64
		row := m.tx.QueryRow(fmt.Sprintf(
			`SELECT setval(pg_get_serial_sequence('%s', 'id'), COALESCE((SELECT MAX(id) FROM %s), 1), (SELECT COUNT(*) > 0 FROM %s))`,
			t, t, t))
		if err := row.Scan(&next); err != nil {
			return fmt.Errorf("setval %s: %w", t, err)
		}
	}
	return nil
}

