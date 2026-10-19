package store

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// ErrTemplateNotFound is returned when a contest-template lookup misses.
var ErrTemplateNotFound = errors.New("contest template not found")

// ErrTemplateNameTaken is returned when a user already owns a template with
// the requested name. Names are unique per owner, not globally, so two
// operators may each keep their own "CQ WW DX" template.
var ErrTemplateNameTaken = errors.New("contest template name already taken")

// ContestTemplate is a reusable contest shape: everything the create-contest
// dialog needs to pre-fill except the station's own identity (callsign,
// station ID, QTH), which stays per-station so a template can be shared
// across a club without dragging one operator's call along.
//
// The JSON-encoded blobs (CustomFields, QSOLayout, LogColumns, ADIFMapping)
// use exactly
// the same encoding as their namesakes on Contest — they are produced and
// consumed by the same frontend editors, so a template round-trips into a
// contest without any translation step.
type ContestTemplate struct {
	ID                 int64     `json:"id"`
	Name               string    `json:"name"`         // template name, shown in the picker
	DefaultName        string    `json:"default_name"` // pre-filled contest name
	Bands              []string  `json:"bands"`
	Objective          string    `json:"objective"`        // markdown text
	CustomFields       string    `json:"custom_fields"`    // JSON array of {name,label,type,required,options,order}
	QSOLayout          string    `json:"qso_layout"`       // JSON {cols, items:[{key,x,y,w}]}
	LogColumns         string    `json:"log_columns"`      // JSON ordered array of {key,on}
	ADIFMapping        string    `json:"adif_mapping"`     // JSON {noctalum field key: ADIF tag} overrides
	CabrilloMapping    string    `json:"cabrillo_mapping"` // JSON {sent:[field keys], received:[field keys]} exchange layout
	NrPadded           bool      `json:"nr_padded"`
	FreqUnit           string    `json:"freq_unit"`
	StashExpiryMinutes int64     `json:"stash_expiry_minutes"`
	Shared             bool      `json:"shared"`        // visible to every user, not just the owner
	OwnerUserID        int64     `json:"owner_user_id"` // 0 = built-in, shipped with the app
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`

	// Populated by ListContestTemplates for the management screen.
	OwnerUsername string `json:"owner_username,omitempty"`
	MyRole        string `json:"my_role,omitempty"` // "owner" | "" (someone else's shared template)
}

// seededSettingKey guards the one-time built-in template seed. Without it the
// "table is empty" check would resurrect a built-in an admin deliberately
// deleted, every time the process restarts.
const templatesSeededSettingKey = "contest_templates_seeded"

func (s *Store) migrateContestTemplates() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS contest_templates (
			id                   BIGSERIAL PRIMARY KEY,
			name                 TEXT NOT NULL,
			default_name         TEXT NOT NULL DEFAULT '',
			bands                TEXT NOT NULL DEFAULT '',
			objective            TEXT NOT NULL DEFAULT '',
			custom_fields        TEXT NOT NULL DEFAULT '',
			qso_layout           TEXT NOT NULL DEFAULT '',
			log_columns          TEXT NOT NULL DEFAULT '',
			adif_mapping         TEXT NOT NULL DEFAULT '',
			cabrillo_mapping     TEXT NOT NULL DEFAULT '',
			nr_padded            BOOLEAN NOT NULL DEFAULT true,
			freq_unit            TEXT NOT NULL DEFAULT 'kHz',
			stash_expiry_minutes BIGINT NOT NULL DEFAULT 60,
			shared               BOOLEAN NOT NULL DEFAULT false,
			owner_user_id        BIGINT NOT NULL DEFAULT 0,
			created_at           TIMESTAMPTZ NOT NULL,
			updated_at           TIMESTAMPTZ NOT NULL
		)`,
		// Unique per owner rather than globally: personal templates are the
		// common case and two operators picking the same obvious name must
		// not collide.
		`CREATE UNIQUE INDEX IF NOT EXISTS contest_templates_owner_name_uniq ON contest_templates (owner_user_id, name)`,
		`CREATE INDEX IF NOT EXISTS idx_contest_templates_shared ON contest_templates (shared)`,
		// Added with the per-contest ADIF mapping editor. Empty means every
		// field keeps its default tag, so existing templates are unaffected.
		`ALTER TABLE contest_templates ADD COLUMN IF NOT EXISTS adif_mapping TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE contest_templates ADD COLUMN IF NOT EXISTS cabrillo_mapping TEXT NOT NULL DEFAULT ''`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return err
		}
	}
	return s.seedBuiltinTemplates()
}

// seedBuiltinTemplates inserts the shared, ownerless built-in templates. Each
// one is seeded at most once ever, tracked by its own settings key — after
// that the catalogue belongs entirely to the operators, and a built-in an
// admin deleted stays deleted. A built-in added in a later release gets a new
// key, so upgrading installations receive it once too.
func (s *Store) seedBuiltinTemplates() error {
	builtins := []struct {
		guardKey string
		tpl      ContestTemplate
	}{
		{
			// The templates that used to live hardcoded in app.js as
			// CONTEST_PRESETS, so upgrades keep the EU DX preset they
			// already had in the create-contest dropdown.
			guardKey: templatesSeededSettingKey,
			tpl: ContestTemplate{
				Name:               "EU DX Contest",
				DefaultName:        "EU DX Contest",
				Bands:              []string{"80m", "40m", "20m", "15m", "10m"},
				CustomFields:       `[{"name":"region_code","label":"Region","type":"text","required":true,"options":[],"order":0}]`,
				NrPadded:           true,
				FreqUnit:           "kHz",
				StashExpiryMinutes: 60,
				Shared:             true,
			},
		},
		{
			// DARC Worked All Germany: German stations send RST + DOK,
			// everyone else RST + serial. The default name doubles as the
			// ADIF CONTEST_ID and the Cabrillo CONTEST: value.
			guardKey: "contest_templates_seeded_wag",
			tpl: ContestTemplate{
				Name:        "Worked All Germany (WAG)",
				DefaultName: "DARC-WAG",
				Bands:       []string{"160m", "80m", "40m", "20m", "15m", "10m"},
				// DOK sits next to the received serial so either can be
				// typed straight after the reports.
				QSOLayout: `{"cols":12,"items":[` +
					`{"key":"callsign","x":0,"y":0,"w":3},{"key":"rst_sent","x":3,"y":0,"w":2},` +
					`{"key":"rst_received","x":5,"y":0,"w":2},{"key":"dok","x":7,"y":0,"w":2},` +
					`{"key":"nr_received","x":9,"y":0,"w":2},` +
					`{"key":"mode","x":0,"y":1,"w":2},{"key":"band","x":2,"y":1,"w":2},` +
					`{"key":"freq","x":4,"y":1,"w":3},{"key":"name","x":7,"y":1,"w":3},` +
					`{"key":"nr_sent","x":0,"y":2,"w":2},{"key":"locator","x":2,"y":2,"w":3},` +
					`{"key":"notes","x":0,"y":3,"w":6},{"key":"time","x":6,"y":3,"w":3}],"removed":[]}`,
				LogColumns: `[{"key":"nr_sent","on":true},{"key":"time","on":true},{"key":"callsign","on":true},` +
					`{"key":"band","on":true},{"key":"freq","on":true},{"key":"mode","on":true},` +
					`{"key":"rst_sent","on":true},{"key":"rst_received","on":true},{"key":"dok","on":true},` +
					`{"key":"nr_received","on":true},{"key":"name","on":false},{"key":"locator","on":false},` +
					`{"key":"distance","on":false},{"key":"itu","on":false},{"key":"lighthouse","on":false},` +
					`{"key":"notes","on":false},{"key":"operator","on":true}]`,
				CabrilloMapping:    `{"sent":["rst_sent","my_dok"],"received":["rst_received","dok_or_nr"]}`,
				NrPadded:           true,
				FreqUnit:           "kHz",
				StashExpiryMinutes: 60,
				Shared:             true,
			},
		},
	}
	now := time.Now().UTC()
	for _, b := range builtins {
		var seeded string
		err := s.db.QueryRow(`SELECT value FROM settings WHERE key = $1`, b.guardKey).Scan(&seeded)
		if err == nil && seeded == "1" {
			continue
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		t := b.tpl
		if _, err := s.db.Exec(
			`INSERT INTO contest_templates
			   (name, default_name, bands, objective, custom_fields, qso_layout, log_columns, adif_mapping, cabrillo_mapping,
			    nr_padded, freq_unit, stash_expiry_minutes, shared, owner_user_id, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$14)
			 ON CONFLICT (owner_user_id, name) DO NOTHING`,
			t.Name, t.DefaultName, bandsToString(t.Bands), t.Objective, t.CustomFields,
			t.QSOLayout, t.LogColumns, t.ADIFMapping, t.CabrilloMapping, t.NrPadded, t.FreqUnit, t.StashExpiryMinutes, t.Shared, now,
		); err != nil {
			return err
		}
		if _, err := s.db.Exec(
			`INSERT INTO settings (key, value) VALUES ($1, '1')
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, b.guardKey); err != nil {
			return err
		}
	}
	return nil
}

// normalizeTemplate applies the same defaults the create/update paths share so
// a half-filled payload from an older client still produces a usable row.
func normalizeTemplate(t *ContestTemplate) error {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" {
		return errors.New("template name required")
	}
	t.DefaultName = strings.TrimSpace(t.DefaultName)
	switch t.FreqUnit {
	case "Hz", "kHz", "MHz", "GHz":
	default:
		t.FreqUnit = "kHz"
	}
	if t.StashExpiryMinutes <= 0 {
		t.StashExpiryMinutes = 60
	}
	if t.Bands == nil {
		t.Bands = []string{}
	}
	return nil
}

// CreateContestTemplate inserts a template owned by ownerUserID.
func (s *Store) CreateContestTemplate(t *ContestTemplate, ownerUserID int64) (*ContestTemplate, error) {
	if err := normalizeTemplate(t); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	t.OwnerUserID = ownerUserID
	t.CreatedAt, t.UpdatedAt = now, now
	err := s.db.QueryRow(
		`INSERT INTO contest_templates
		   (name, default_name, bands, objective, custom_fields, qso_layout, log_columns, adif_mapping, cabrillo_mapping,
		    nr_padded, freq_unit, stash_expiry_minutes, shared, owner_user_id, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
		 RETURNING id`,
		t.Name, t.DefaultName, bandsToString(t.Bands), t.Objective, t.CustomFields,
		t.QSOLayout, t.LogColumns, t.ADIFMapping, t.CabrilloMapping, t.NrPadded, t.FreqUnit, t.StashExpiryMinutes,
		t.Shared, ownerUserID, now,
	).Scan(&t.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrTemplateNameTaken
		}
		return nil, err
	}
	return t, nil
}

const templateSelectCols = `id, name, default_name, bands, objective, custom_fields, qso_layout,
	log_columns, adif_mapping, cabrillo_mapping, nr_padded, freq_unit, stash_expiry_minutes, shared, owner_user_id, created_at, updated_at`

func scanTemplate(sc interface{ Scan(...any) error }) (*ContestTemplate, error) {
	var t ContestTemplate
	var bands string
	if err := sc.Scan(&t.ID, &t.Name, &t.DefaultName, &bands, &t.Objective, &t.CustomFields,
		&t.QSOLayout, &t.LogColumns, &t.ADIFMapping, &t.CabrilloMapping, &t.NrPadded, &t.FreqUnit, &t.StashExpiryMinutes,
		&t.Shared, &t.OwnerUserID, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	t.Bands = bandsFromString(bands)
	t.CreatedAt = t.CreatedAt.UTC()
	t.UpdatedAt = t.UpdatedAt.UTC()
	return &t, nil
}

// GetContestTemplate returns one template regardless of visibility — callers
// are responsible for the access check (see Server.canUseTemplate).
func (s *Store) GetContestTemplate(id int64) (*ContestTemplate, error) {
	t, err := scanTemplate(s.db.QueryRow(`SELECT `+templateSelectCols+` FROM contest_templates WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTemplateNotFound
	}
	return t, err
}

// ListContestTemplates returns every template the user may use: their own
// plus everything marked shared. Ordered shared-last so a user's personal
// templates sit at the top of the picker.
func (s *Store) ListContestTemplates(userID int64) ([]ContestTemplate, error) {
	rows, err := s.db.Query(
		`SELECT t.id, t.name, t.default_name, t.bands, t.objective, t.custom_fields, t.qso_layout,
		        t.log_columns, t.adif_mapping, t.cabrillo_mapping, t.nr_padded, t.freq_unit, t.stash_expiry_minutes, t.shared,
		        t.owner_user_id, t.created_at, t.updated_at,
		        COALESCE(u.username, '') AS owner_username
		 FROM contest_templates t
		 LEFT JOIN users u ON u.id = t.owner_user_id
		 WHERE t.owner_user_id = $1 OR t.shared
		 ORDER BY (t.owner_user_id = $1) DESC, t.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContestTemplate
	for rows.Next() {
		var t ContestTemplate
		var bands string
		if err := rows.Scan(&t.ID, &t.Name, &t.DefaultName, &bands, &t.Objective, &t.CustomFields,
			&t.QSOLayout, &t.LogColumns, &t.ADIFMapping, &t.CabrilloMapping, &t.NrPadded, &t.FreqUnit, &t.StashExpiryMinutes,
			&t.Shared, &t.OwnerUserID, &t.CreatedAt, &t.UpdatedAt, &t.OwnerUsername); err != nil {
			return nil, err
		}
		t.Bands = bandsFromString(bands)
		t.CreatedAt = t.CreatedAt.UTC()
		t.UpdatedAt = t.UpdatedAt.UTC()
		if t.OwnerUserID != 0 && t.OwnerUserID == userID {
			t.MyRole = "owner"
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// UpdateContestTemplate replaces every editable field of a template. Ownership
// is not changed — a shared template stays with its original author even when
// an admin edits it.
func (s *Store) UpdateContestTemplate(id int64, t *ContestTemplate) error {
	if err := normalizeTemplate(t); err != nil {
		return err
	}
	res, err := s.db.Exec(
		`UPDATE contest_templates
		 SET name = $1, default_name = $2, bands = $3, objective = $4, custom_fields = $5,
		     qso_layout = $6, log_columns = $7, adif_mapping = $8, cabrillo_mapping = $9,
		     nr_padded = $10, freq_unit = $11,
		     stash_expiry_minutes = $12, shared = $13, updated_at = $14
		 WHERE id = $15`,
		t.Name, t.DefaultName, bandsToString(t.Bands), t.Objective, t.CustomFields,
		t.QSOLayout, t.LogColumns, t.ADIFMapping, t.CabrilloMapping, t.NrPadded, t.FreqUnit, t.StashExpiryMinutes,
		t.Shared, time.Now().UTC(), id,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrTemplateNameTaken
		}
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrTemplateNotFound
	}
	return nil
}

// DeleteContestTemplate removes a template. Contests created from it are
// unaffected — a template is a one-shot pre-fill, never a live link.
func (s *Store) DeleteContestTemplate(id int64) error {
	res, err := s.db.Exec(`DELETE FROM contest_templates WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrTemplateNotFound
	}
	return nil
}
