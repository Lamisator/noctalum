// Package adif holds the ADIF QSO-field catalogue shared by the contest
// settings UI and the ADIF exporter.
//
// The catalogue itself lives in fields_gen.go, generated straight from the
// published ADIF specification by cmd/gen-adif-fields. Regenerate it after an
// ADIF release:
//
//	go run ./cmd/gen-adif-fields
//
// The browser gets the same data from internal/server/web/adif-fields.js,
// written by the same generator run — the two never drift apart by hand.
package adif

import "strings"

// Field describes one ADIF QSO field.
type Field struct {
	// Name is the ADIF tag, upper case (e.g. "POTA_REF").
	Name string
	// Type is the ADIF data type verbatim from the spec (e.g. "Date",
	// "PositiveInteger", "Enumeration"). Normalize keys off it.
	Type string
	// Input is the form control the QSO entry mask renders:
	// text | number | select | date | time | textarea.
	Input string
	// Options are the legal values for a closed enumeration; nil otherwise.
	Options []string
	// Group is the picker section this field belongs to.
	Group string
	// Status is why a field may not be freely addable:
	//
	//	""           operator may add it to a contest
	//	"builtin"    Noctalum already logs it from a dedicated QSO column
	//	"intl"       UTF-8 sibling of another field, emitted automatically
	//	"deprecated" import-only per the spec
	Status string
	// Intl names the UTF-8 sibling field ("<NAME>_INTL"), when the spec
	// defines one. The exporter switches to it for non-ASCII values.
	Intl string
	// Replaces names the field to use instead of a deprecated one.
	Replaces string
}

// Status values. Kept as constants so callers do not spell them by hand.
const (
	StatusAddable    = ""
	StatusBuiltin    = "builtin"
	StatusIntl       = "intl"
	StatusDeprecated = "deprecated"
)

var byName = func() map[string]*Field {
	m := make(map[string]*Field, len(Fields))
	for i := range Fields {
		m[Fields[i].Name] = &Fields[i]
	}
	return m
}()

// Lookup returns the catalogue entry for an ADIF tag. The name is matched
// case-insensitively; callers that already uppercased pay nothing extra.
func Lookup(name string) (*Field, bool) {
	f, ok := byName[strings.ToUpper(name)]
	return f, ok
}

// Exportable reports whether a value stored under this name may be written to
// ADIF under its own standard tag, returning the catalogue entry when it may.
//
// Two statuses are refused:
//
//   - "builtin" — Noctalum emits the tag itself from a dedicated QSO column.
//     Letting a same-named custom field through would write the tag twice, and
//     ADIF forbids repeating a field within a record.
//   - "deprecated" — the spec marks it import-only, so emitting it produces a
//     file strict validators reject.
//
// Refused names are not dropped by the caller: they fall back to the
// APP_<PROGRAMID>_<NAME> namespace, which is ADIF's escape hatch for
// application-specific data and is ignored rather than rejected by importers.
func Exportable(name string) (*Field, bool) {
	f, ok := Lookup(name)
	if !ok || f.Status == StatusBuiltin || f.Status == StatusDeprecated {
		return nil, false
	}
	return f, true
}

// Normalize converts an operator-entered value into the on-the-wire form the
// field's ADIF data type requires, returning "" when nothing usable is left.
//
// It exists because the QSO entry mask renders native date and time controls
// for Date/Time fields, and those hand back ISO-ish strings ("2026-03-22",
// "14:05") rather than the compact ADIF forms ("20260322", "140500"). Values
// that already look right are passed through, so hand-typed and imported data
// round-trips unchanged.
func Normalize(f *Field, value string) string {
	v := strings.TrimSpace(value)
	if v == "" || f == nil {
		return v
	}
	switch f.Type {
	case "Date":
		digits := keepDigits(v)
		if len(digits) == 8 {
			return digits
		}
		return "" // not a date we can express in ADIF — drop rather than emit garbage
	case "Time":
		digits := keepDigits(v)
		switch len(digits) {
		case 4:
			return digits + "00"
		case 6:
			return digits
		}
		return ""
	case "Boolean":
		switch strings.ToUpper(v) {
		case "Y", "YES", "TRUE", "1":
			return "Y"
		case "N", "NO", "FALSE", "0":
			return "N"
		}
		return ""
	default:
		return v
	}
}

func keepDigits(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
