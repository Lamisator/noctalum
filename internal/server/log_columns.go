package server

import (
	"encoding/json"
	"strings"
)

// LogColumn is one resolved column for exports.
type LogColumn struct {
	Key      string
	Label    string
	IsCustom bool
}

type logColDef struct {
	key       string
	labelEN   string
	labelDE   string
	defaultOn bool
}

// Mirrors LOG_COL_DEFS in internal/server/web/app.js — keep in sync.
var builtinLogColumns = []logColDef{
	{"nr_sent", "Nr", "Nr", true},
	{"time", "Time UTC", "Zeit UTC", true},
	{"callsign", "Call", "Rufzeichen", true},
	{"band", "Band", "Band", true},
	{"freq", "Freq (MHz)", "Freq (MHz)", true},
	{"mode", "Mode", "Mode", true},
	{"rst_sent", "Sent", "Gegeben", true},
	{"rst_received", "Rcv", "Empfangen", true},
	{"nr_received", "Nr rcvd", "Nr empf.", false},
	{"name", "Name", "Name", false},
	{"locator", "Loc", "Loc", true},
	{"itu", "ITU/CQ", "ITU/CQ", true},
	{"dok", "DOK", "DOK", false},
	{"lighthouse", "Lighthouse", "Leuchtturm", false},
	{"notes", "Notes", "Notizen", false},
	{"operator", "Op", "Op", true},
}

type customFieldDef struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// parseCustomFieldDefs decodes a contest's custom_fields JSON into the
// ordered list of field definitions. It is tolerant of empty / malformed input
// and never returns nil — exports rely on the slice length to know whether
// any extra columns should be emitted.
func parseCustomFieldDefs(raw string) []customFieldDef {
	out := []customFieldDef{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

type savedLogColEntry struct {
	Key string `json:"key"`
	On  bool   `json:"on"`
}

// ResolveLogColumns returns the user's effective column list for the contest,
// merging the built-in columns with the contest's custom fields and applying
// the saved log_columns ordering & visibility. When onlyVisible is true, only
// columns marked visible (on=true) are returned.
func ResolveLogColumns(logColumnsJSON, customFieldsJSON, lang string, onlyVisible bool) []LogColumn {
	// Build the master list of all known columns (built-in + custom).
	type def struct {
		key       string
		label     string
		isCustom  bool
		defaultOn bool
	}
	all := make([]def, 0, len(builtinLogColumns)+4)
	for _, b := range builtinLogColumns {
		lbl := b.labelEN
		if strings.EqualFold(lang, "de") {
			lbl = b.labelDE
		}
		all = append(all, def{b.key, lbl, false, b.defaultOn})
	}
	var customs []customFieldDef
	if strings.TrimSpace(customFieldsJSON) != "" {
		_ = json.Unmarshal([]byte(customFieldsJSON), &customs)
	}
	for _, c := range customs {
		if c.Name == "" {
			continue
		}
		label := c.Label
		if label == "" {
			label = c.Name
		}
		all = append(all, def{c.Name, label, true, false})
	}

	// Apply the saved ordering / visibility.
	var saved []savedLogColEntry
	if strings.TrimSpace(logColumnsJSON) != "" {
		_ = json.Unmarshal([]byte(logColumnsJSON), &saved)
	}

	defByKey := make(map[string]def, len(all))
	for _, d := range all {
		defByKey[d.key] = d
	}

	result := make([]LogColumn, 0, len(all))
	seen := make(map[string]bool, len(all))
	if len(saved) > 0 {
		for _, s := range saved {
			d, ok := defByKey[s.Key]
			if !ok {
				continue
			}
			if onlyVisible && !s.On {
				seen[s.Key] = true
				continue
			}
			result = append(result, LogColumn{Key: d.key, Label: d.label, IsCustom: d.isCustom})
			seen[s.Key] = true
		}
		// Append any columns not present in the saved order, using their default state.
		for _, d := range all {
			if seen[d.key] {
				continue
			}
			if onlyVisible && !d.defaultOn {
				continue
			}
			result = append(result, LogColumn{Key: d.key, Label: d.label, IsCustom: d.isCustom})
		}
	} else {
		// No saved order — use defaults.
		for _, d := range all {
			if onlyVisible && !d.defaultOn {
				continue
			}
			result = append(result, LogColumn{Key: d.key, Label: d.label, IsCustom: d.isCustom})
		}
	}
	return result
}

// FilterColumnsByKeys returns the subset of cols whose Key is in the given
// ordered list of keys. Keys missing from cols are silently dropped, so the
// result preserves the order from keys.
func FilterColumnsByKeys(cols []LogColumn, keys []string) []LogColumn {
	if len(keys) == 0 {
		return cols
	}
	byKey := make(map[string]LogColumn, len(cols))
	for _, c := range cols {
		byKey[c.Key] = c
	}
	out := make([]LogColumn, 0, len(keys))
	for _, k := range keys {
		if c, ok := byKey[k]; ok {
			out = append(out, c)
		}
	}
	return out
}
