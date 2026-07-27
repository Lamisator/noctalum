package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var ErrContestNotFound = errors.New("contest not found")

// Contest visibility values.
//
// The authoritative access model since the per-contest permission overhaul:
//
//   - VisibilityOpen: any authenticated user may enter and log QSOs; they are
//     auto-joined as a "logger" participant on first activity.
//   - VisibilityGroups: only members of one of the contest's linked groups may
//     enter; they are also auto-joined as "logger".
//   - VisibilityPrivate: invite-only — access is granted via contest_access or
//     explicit participant records (owner/editor/logger).
//
// The legacy Private / AccessRestricted booleans are kept in sync with
// Visibility on writes so older UI paths and audit / share flows keep working.
const (
	VisibilityOpen    = "open"
	VisibilityGroups  = "groups"
	VisibilityPrivate = "private"
)

// Contest represents a single ham radio contest event.
type Contest struct {
	ID                 int64      `json:"id"`
	Name               string     `json:"name"`
	StationCall        string     `json:"station_call"`
	StationID          string     `json:"station_id"` // contest-specific operator/station identifier
	QTH                string     `json:"qth"`        // Maidenhead locator of the station
	Status             string     `json:"status"`     // "open" | "finished"
	Bands              []string   `json:"bands"`      // active bands for this contest
	Objective          string     `json:"objective"`  // markdown text
	Visibility         string     `json:"visibility"` // "open" | "groups" | "private"
	Private            bool       `json:"private"`    // owner-only contest (kept in sync with Visibility=="private" for backward compat)
	OwnerUserID        int64      `json:"owner_user_id"`
	CustomFields       string     `json:"custom_fields"`        // JSON-encoded array of {name,label,type,required,order}
	QSOLayout          string     `json:"qso_layout"`           // JSON-encoded {cols, items:[{key,x,y,w}]} for the New QSO mask
	LogColumns         string     `json:"log_columns"`          // JSON-encoded ordered array of {key,on} for log table columns
	AccessRestricted   bool       `json:"access_restricted"`    // when true, only access-listed users / owners / admins can see & enter (kept in sync with Visibility!="open" for backward compat)
	NrPadded           bool       `json:"nr_padded"`            // display serial numbers zero-padded to 3 digits
	StashExpiryMinutes int64      `json:"stash_expiry_minutes"` // auto-delete stashed pre-QSOs after this many minutes (default 60)
	FreqUnit           string     `json:"freq_unit"`            // display unit for frequency: "Hz", "kHz", "MHz", "GHz" (default "kHz")
	StartDate          *time.Time `json:"start_date"`           // optional calendar date the contest starts (UTC-anchored midnight)
	EndDate            *time.Time `json:"end_date"`             // optional calendar date the contest ends; when nil but StartDate set, it is a single-day contest
	CreatedAt          time.Time  `json:"created_at"`
	LastActivityAt     *time.Time `json:"last_activity_at"` // time of the most recent QSO; nil if no QSOs logged
}

// NormalizeVisibility maps the (private, accessRestricted, requested)
// booleans/strings to a canonical visibility value. An empty or unknown
// requested visibility falls back to the legacy booleans so callers that don't
// pass an explicit value keep their existing semantics.
func NormalizeVisibility(requested string, private, accessRestricted bool) string {
	switch requested {
	case VisibilityOpen, VisibilityGroups, VisibilityPrivate:
		return requested
	}
	if private {
		return VisibilityPrivate
	}
	if accessRestricted {
		return VisibilityPrivate
	}
	return VisibilityOpen
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

// isUniqueViolation reports whether err is a Postgres unique-constraint
// violation (SQLSTATE 23505). Callers use it to translate driver errors
// into the package's typed errors (ErrUsernameTaken, ErrRoleNameTaken,
// "contest name already in use", …).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *Store) migrateContests() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS contests (
			id                   BIGSERIAL PRIMARY KEY,
			name                 TEXT NOT NULL UNIQUE,
			station_call         TEXT NOT NULL,
			qth                  TEXT NOT NULL DEFAULT '',
			bands                TEXT NOT NULL DEFAULT '',
			objective            TEXT NOT NULL DEFAULT '',
			status               TEXT NOT NULL DEFAULT 'open',
			station_id           TEXT NOT NULL DEFAULT '',
			private              BOOLEAN NOT NULL DEFAULT false,
			owner_user_id        BIGINT NOT NULL DEFAULT 0,
			custom_fields        TEXT NOT NULL DEFAULT '',
			qso_layout           TEXT NOT NULL DEFAULT '',
			log_columns          TEXT NOT NULL DEFAULT '',
			access_restricted    BOOLEAN NOT NULL DEFAULT false,
			nr_padded            BOOLEAN NOT NULL DEFAULT true,
			stash_expiry_minutes BIGINT NOT NULL DEFAULT 60,
			freq_unit            TEXT NOT NULL DEFAULT 'kHz',
			start_date           DATE,
			end_date             DATE,
			created_at           TIMESTAMPTZ NOT NULL
		)`,
		`ALTER TABLE contests ADD COLUMN IF NOT EXISTS start_date DATE`,
		`ALTER TABLE contests ADD COLUMN IF NOT EXISTS end_date   DATE`,
		// Authoritative visibility mode ("open" | "groups" | "private"),
		// added when per-contest permissions were introduced. Backfill
		// derives it from the legacy private/access_restricted booleans;
		// on writes we keep both columns synchronised so older UI paths
		// keep working.
		`ALTER TABLE contests ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open'`,
		`UPDATE contests SET visibility = CASE
		    WHEN private OR access_restricted THEN 'private'
		    ELSE 'open'
		 END
		 WHERE visibility = '' OR visibility IS NULL OR visibility NOT IN ('open','groups','private')`,
		`CREATE INDEX IF NOT EXISTS idx_contests_status ON contests(status)`,
		`CREATE TABLE IF NOT EXISTS contest_access (
			contest_id BIGINT NOT NULL,
			user_id    BIGINT NOT NULL,
			PRIMARY KEY (contest_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS contest_participants (
			contest_id BIGINT      NOT NULL,
			user_id    BIGINT      NOT NULL,
			role       TEXT        NOT NULL DEFAULT 'logger',
			status     TEXT        NOT NULL DEFAULT 'pending',
			joined_at  TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (contest_id, user_id)
		)`,
		// Rename the legacy "user" role to "logger" so the participant
		// role vocabulary is {owner, editor, logger}. Editor is new.
		`UPDATE contest_participants SET role = 'logger' WHERE role = 'user'`,
		// Groups let admins pre-assemble reusable sets of users. Any
		// registered user with groups.manage may create a group and
		// becomes its first owner via group_members.is_owner=true.
		`CREATE TABLE IF NOT EXISTS groups (
			id          BIGSERIAL PRIMARY KEY,
			name        TEXT NOT NULL UNIQUE,
			created_by  BIGINT NOT NULL DEFAULT 0,
			created_at  TIMESTAMPTZ NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS group_members (
			group_id  BIGINT      NOT NULL,
			user_id   BIGINT      NOT NULL,
			is_owner  BOOLEAN     NOT NULL DEFAULT false,
			added_at  TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (group_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)`,
		// Contest-to-group access — every member of a listed group is an
		// implicit logger for the contest (auto-joined on first QSO).
		`CREATE TABLE IF NOT EXISTS contest_group_access (
			contest_id BIGINT NOT NULL,
			group_id   BIGINT NOT NULL,
			PRIMARY KEY (contest_id, group_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_contest_group_access_group ON contest_group_access(group_id)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate contests: %w", err)
		}
	}
	return nil
}

// CreateContest inserts a new contest in 'open' status.
// startDate and endDate are optional (nil = unset); when both are non-nil the
// caller is expected to have already validated end >= start.
// visibility is one of VisibilityOpen / VisibilityGroups / VisibilityPrivate;
// the legacy private / access_restricted booleans are derived from it so that
// callers still using the old API keep seeing consistent data.
func (s *Store) CreateContest(name, stationCall, qth string, bands []string, objective, stationID string, visibility string, ownerUserID int64, customFields, qsoLayout, logColumns string, nrPadded bool, stashExpiryMinutes int64, freqUnit string, startDate, endDate *time.Time) (*Contest, error) {
	name = strings.TrimSpace(name)
	stationCall = strings.ToUpper(strings.TrimSpace(stationCall))
	qth = strings.ToUpper(strings.TrimSpace(qth))
	stationID = strings.TrimSpace(stationID)
	if stashExpiryMinutes <= 0 {
		stashExpiryMinutes = 60
	}
	if freqUnit == "" {
		freqUnit = "kHz"
	}
	visibility = NormalizeVisibility(visibility, false, false)
	private := visibility == VisibilityPrivate
	accessRestricted := visibility != VisibilityOpen
	startArg := nullableDate(startDate)
	endArg := nullableDate(endDate)
	now := time.Now().UTC()
	var id int64
	err := s.db.QueryRow(
		`INSERT INTO contests (name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, log_columns, access_restricted, visibility, nr_padded, stash_expiry_minutes, freq_unit, start_date, end_date, created_at)
		 VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
		name, stationCall, qth, bandsToString(bands), objective, stationID, private, ownerUserID, customFields, qsoLayout, logColumns, accessRestricted, visibility, nrPadded, stashExpiryMinutes, freqUnit, startArg, endArg, now,
	).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, errors.New("contest name already in use")
		}
		return nil, err
	}
	return &Contest{ID: id, Name: name, StationCall: stationCall, QTH: qth, Bands: bands, Objective: objective, Status: "open", StationID: stationID, Visibility: visibility, Private: private, OwnerUserID: ownerUserID, CustomFields: customFields, QSOLayout: qsoLayout, LogColumns: logColumns, AccessRestricted: accessRestricted, NrPadded: nrPadded, StashExpiryMinutes: stashExpiryMinutes, FreqUnit: freqUnit, StartDate: normalizeDate(startDate), EndDate: normalizeDate(endDate), CreatedAt: now}, nil
}

// nullableDate returns the SQL argument for an optional date column: the
// UTC-midnight time value if t is non-nil, or nil to insert SQL NULL.
func nullableDate(t *time.Time) any {
	if t == nil {
		return nil
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// normalizeDate returns a copy of t truncated to UTC midnight, or nil.
func normalizeDate(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	d := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	return &d
}

// ListContests returns all contests, newest first, with last QSO activity time.
func (s *Store) ListContests() ([]Contest, error) {
	rows, err := s.db.Query(
		`SELECT c.id, c.name, c.station_call, c.qth, c.bands, c.objective, c.status, c.station_id,
		        c.private, c.owner_user_id, c.custom_fields, c.qso_layout, c.log_columns, c.access_restricted, c.visibility, c.nr_padded, c.stash_expiry_minutes, c.freq_unit, c.start_date, c.end_date, c.created_at,
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
		var bandsStr string
		var lastAct sql.NullTime
		var startDate, endDate sql.NullTime
		if err := rows.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &c.Private, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &c.LogColumns, &c.AccessRestricted, &c.Visibility, &c.NrPadded, &c.StashExpiryMinutes, &c.FreqUnit, &startDate, &endDate, &c.CreatedAt, &lastAct); err != nil {
			return nil, err
		}
		c.Bands = bandsFromString(bandsStr)
		c.Visibility = NormalizeVisibility(c.Visibility, c.Private, c.AccessRestricted)
		c.CreatedAt = c.CreatedAt.UTC()
		if startDate.Valid {
			d := startDate.Time.UTC()
			c.StartDate = normalizeDate(&d)
		}
		if endDate.Valid {
			d := endDate.Time.UTC()
			c.EndDate = normalizeDate(&d)
		}
		if lastAct.Valid {
			la := lastAct.Time.UTC()
			c.LastActivityAt = &la
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContest returns a single contest by ID.
func (s *Store) GetContest(id int64) (*Contest, error) {
	row := s.db.QueryRow(
		`SELECT id, name, station_call, qth, bands, objective, status, station_id, private, owner_user_id, custom_fields, qso_layout, log_columns, access_restricted, visibility, nr_padded, stash_expiry_minutes, freq_unit, start_date, end_date, created_at FROM contests WHERE id = $1`, id)
	var c Contest
	var bandsStr string
	var startDate, endDate sql.NullTime
	if err := row.Scan(&c.ID, &c.Name, &c.StationCall, &c.QTH, &bandsStr, &c.Objective, &c.Status, &c.StationID, &c.Private, &c.OwnerUserID, &c.CustomFields, &c.QSOLayout, &c.LogColumns, &c.AccessRestricted, &c.Visibility, &c.NrPadded, &c.StashExpiryMinutes, &c.FreqUnit, &startDate, &endDate, &c.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrContestNotFound
		}
		return nil, err
	}
	c.Bands = bandsFromString(bandsStr)
	c.Visibility = NormalizeVisibility(c.Visibility, c.Private, c.AccessRestricted)
	c.CreatedAt = c.CreatedAt.UTC()
	if startDate.Valid {
		d := startDate.Time.UTC()
		c.StartDate = normalizeDate(&d)
	}
	if endDate.Valid {
		d := endDate.Time.UTC()
		c.EndDate = normalizeDate(&d)
	}
	return &c, nil
}

// SetContestVisibility flips a contest's visibility mode and keeps the legacy
// private / access_restricted booleans in sync so older queries and audit
// hooks remain accurate.
func (s *Store) SetContestVisibility(contestID int64, visibility string) error {
	visibility = NormalizeVisibility(visibility, false, false)
	private := visibility == VisibilityPrivate
	accessRestricted := visibility != VisibilityOpen
	_, err := s.db.Exec(
		`UPDATE contests SET visibility = $1, private = $2, access_restricted = $3 WHERE id = $4`,
		visibility, private, accessRestricted, contestID,
	)
	return err
}

// UpdateContest updates name, station_call, qth, bands, objective and status of an existing contest.
// startDate/endDate follow the same optional semantics as CreateContest — pass
// nil to store SQL NULL (clears the date). Visibility is *not* touched here;
// call SetContestVisibility() to change it (owner-only endpoint).
func (s *Store) UpdateContest(id int64, name, stationCall, qth, status string, bands []string, objective, stationID, customFields, qsoLayout, logColumns string, nrPadded bool, stashExpiryMinutes int64, freqUnit string, startDate, endDate *time.Time) error {
	if stashExpiryMinutes <= 0 {
		stashExpiryMinutes = 60
	}
	if freqUnit == "" {
		freqUnit = "kHz"
	}
	_, err := s.db.Exec(
		`UPDATE contests SET name = $1, station_call = $2, qth = $3, bands = $4, objective = $5, status = $6, station_id = $7, custom_fields = $8, qso_layout = $9, log_columns = $10, nr_padded = $11, stash_expiry_minutes = $12, freq_unit = $13, start_date = $14, end_date = $15 WHERE id = $16`,
		strings.TrimSpace(name), strings.ToUpper(strings.TrimSpace(stationCall)),
		strings.ToUpper(strings.TrimSpace(qth)), bandsToString(bands), objective, status,
		strings.TrimSpace(stationID), customFields, qsoLayout, logColumns, nrPadded, stashExpiryMinutes, freqUnit, nullableDate(startDate), nullableDate(endDate), id,
	)
	return err
}

// DuplicateContest creates a new contest that copies the source contest's
// configuration (custom fields, QSO layout, log columns, bands, etc.) but
// starts empty — no QSOs, no access list, no participants other than the
// new owner.  The new contest's status is always reset to "open" and
// last_activity_at starts unset.  Station-level fields are copied as a
// reasonable starting point; callers can edit them after creation.
func (s *Store) DuplicateContest(srcID int64, newName string, ownerUserID int64) (*Contest, error) {
	src, err := s.GetContest(srcID)
	if err != nil {
		return nil, err
	}
	return s.CreateContest(
		newName,
		src.StationCall,
		src.QTH,
		src.Bands,
		src.Objective,
		src.StationID,
		src.Visibility,
		ownerUserID,
		src.CustomFields,
		src.QSOLayout,
		src.LogColumns,
		src.NrPadded,
		src.StashExpiryMinutes,
		src.FreqUnit,
		nil,
		nil,
	)
}

// AutoCloseExpiredContests flips any 'open' contest whose scheduled last day
// has already passed (relative to now, UTC) to 'finished'. It returns the IDs
// that were closed so the caller can broadcast contest_updated events.
//
// The "last day" is:
//   - end_date if set, else
//   - start_date if only start_date is set (single-day contest).
//
// A contest with neither date is never auto-closed.
func (s *Store) AutoCloseExpiredContests(now time.Time) ([]int64, error) {
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	rows, err := s.db.Query(
		`UPDATE contests
		 SET status = 'finished'
		 WHERE status = 'open'
		   AND COALESCE(end_date, start_date) IS NOT NULL
		   AND COALESCE(end_date, start_date) < $1
		 RETURNING id`, today)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// DeleteContest removes a contest, its access list, participants, group
// access rows, and any outstanding share tokens that point at it.
func (s *Store) DeleteContest(id int64) error {
	if _, err := s.db.Exec(`DELETE FROM contest_access WHERE contest_id = $1`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM contest_participants WHERE contest_id = $1`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM contest_group_access WHERE contest_id = $1`, id); err != nil {
		return err
	}
	if err := s.DeleteSharesForContest(id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM contests WHERE id = $1`, id)
	return err
}

// GrantContestAccess gives a user access to a private contest.
func (s *Store) GrantContestAccess(contestID, userID int64) error {
	_, err := s.db.Exec(
		`INSERT INTO contest_access (contest_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		contestID, userID)
	return err
}

// RevokeContestAccess removes a user's access to a private contest.
func (s *Store) RevokeContestAccess(contestID, userID int64) error {
	_, err := s.db.Exec(`DELETE FROM contest_access WHERE contest_id = $1 AND user_id = $2`, contestID, userID)
	return err
}

// HasContestAccess returns true if the user has been explicitly granted access.
func (s *Store) HasContestAccess(contestID, userID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM contest_access WHERE contest_id = $1 AND user_id = $2`, contestID, userID).Scan(&n)
	return n > 0, err
}

// GetContestAccessList returns all user IDs that have been granted access to a contest.
func (s *Store) GetContestAccessList(contestID int64) ([]int64, error) {
	rows, err := s.db.Query(`SELECT user_id FROM contest_access WHERE contest_id = $1`, contestID)
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
		 WHERE ca.contest_id = $1
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
	_, err := s.db.Exec(`UPDATE contests SET access_restricted = $1 WHERE id = $2`, restricted, contestID)
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

// Per-contest participant roles. Owner has full rights (edit contest, manage
// members, edit/delete any QSO); editor may edit/delete any QSO but not
// manage the contest; logger may create QSOs and edit/delete only their own.
const (
	ContestRoleOwner  = "owner"
	ContestRoleEditor = "editor"
	ContestRoleLogger = "logger"
)

// ContestParticipant represents a user's participation in a contest.
type ContestParticipant struct {
	ContestID int64     `json:"contest_id"`
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	Callsign  string    `json:"callsign"`
	Role      string    `json:"role"`   // "owner" | "editor" | "logger"
	Status    string    `json:"status"` // "active" | "pending"
	JoinedAt  time.Time `json:"joined_at"`
}

// AddContestParticipant inserts a participant with the given role and status.
func (s *Store) AddContestParticipant(contestID, userID int64, role, status string) error {
	_, err := s.db.Exec(
		`INSERT INTO contest_participants (contest_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
		contestID, userID, role, status, time.Now().UTC(),
	)
	return err
}

// RequestContestParticipant inserts the user as a pending participant if not already present.
func (s *Store) RequestContestParticipant(contestID, userID int64) error {
	_, err := s.db.Exec(
		`INSERT INTO contest_participants (contest_id, user_id, role, status, joined_at) VALUES ($1, $2, 'logger', 'pending', $3) ON CONFLICT DO NOTHING`,
		contestID, userID, time.Now().UTC(),
	)
	return err
}

// GetContestParticipants returns all participants for a contest, joined with user info.
func (s *Store) GetContestParticipants(contestID int64) ([]ContestParticipant, error) {
	rows, err := s.db.Query(
		`SELECT cp.contest_id, cp.user_id, u.username, u.callsign, cp.role, cp.status, cp.joined_at
		 FROM contest_participants cp
		 JOIN users u ON u.id = cp.user_id
		 WHERE cp.contest_id = $1
		 ORDER BY cp.role DESC, u.username`, contestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContestParticipant
	for rows.Next() {
		var p ContestParticipant
		if err := rows.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &p.JoinedAt); err != nil {
			return nil, err
		}
		p.JoinedAt = p.JoinedAt.UTC()
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
		 WHERE cp.contest_id = $1 AND cp.user_id = $2`, contestID, userID)
	var p ContestParticipant
	if err := row.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &p.JoinedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	p.JoinedAt = p.JoinedAt.UTC()
	return &p, nil
}

// UpdateContestParticipant changes role and/or status for an existing participant.
func (s *Store) UpdateContestParticipant(contestID, userID int64, role, status string) error {
	_, err := s.db.Exec(
		`UPDATE contest_participants SET role = $1, status = $2 WHERE contest_id = $3 AND user_id = $4`,
		role, status, contestID, userID,
	)
	return err
}

// RemoveContestParticipant deletes a participant from a contest.
func (s *Store) RemoveContestParticipant(contestID, userID int64) error {
	_, err := s.db.Exec(`DELETE FROM contest_participants WHERE contest_id = $1 AND user_id = $2`, contestID, userID)
	return err
}

// GetUserParticipations returns all contest participations for a user, keyed by contest ID.
func (s *Store) GetUserParticipations(userID int64) (map[int64]ContestParticipant, error) {
	rows, err := s.db.Query(
		`SELECT cp.contest_id, cp.user_id, u.username, u.callsign, cp.role, cp.status, cp.joined_at
		 FROM contest_participants cp
		 JOIN users u ON u.id = cp.user_id
		 WHERE cp.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]ContestParticipant)
	for rows.Next() {
		var p ContestParticipant
		if err := rows.Scan(&p.ContestID, &p.UserID, &p.Username, &p.Callsign, &p.Role, &p.Status, &p.JoinedAt); err != nil {
			return nil, err
		}
		p.JoinedAt = p.JoinedAt.UTC()
		out[p.ContestID] = p
	}
	return out, rows.Err()
}
