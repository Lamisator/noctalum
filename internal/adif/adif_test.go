package adif

import "testing"

// The catalogue is generated, so these tests are really about the invariants
// the exporter and the field picker rely on holding for *every* entry.
func TestCatalogueInvariants(t *testing.T) {
	if len(Fields) == 0 {
		t.Fatal("catalogue is empty — did cmd/gen-adif-fields run?")
	}
	seen := map[string]bool{}
	inputs := map[string]bool{"text": true, "number": true, "select": true, "date": true, "time": true, "textarea": true}
	groups := map[string]bool{"qso": true, "contacted": true, "mystation": true, "contest": true, "refs": true, "prop": true, "qsl": true, "uploads": true}
	for _, f := range Fields {
		if seen[f.Name] {
			t.Errorf("%s: duplicate entry", f.Name)
		}
		seen[f.Name] = true
		if !inputs[f.Input] {
			t.Errorf("%s: unknown input kind %q", f.Name, f.Input)
		}
		if !groups[f.Group] {
			t.Errorf("%s: unknown group %q", f.Name, f.Group)
		}
		switch f.Status {
		case StatusAddable, StatusBuiltin, StatusIntl, StatusDeprecated:
		default:
			t.Errorf("%s: unknown status %q", f.Name, f.Status)
		}
		if f.Input == "select" && len(f.Options) == 0 && f.Type != "Boolean" {
			t.Errorf("%s: select input without options", f.Name)
		}
		if f.Intl != "" {
			sib, ok := Lookup(f.Intl)
			if !ok {
				t.Errorf("%s: Intl sibling %s is not in the catalogue", f.Name, f.Intl)
			} else if sib.Status != StatusIntl {
				t.Errorf("%s: Intl sibling %s has status %q, want %q", f.Name, f.Intl, sib.Status, StatusIntl)
			}
		}
	}
}

// Every field Noctalum writes from a dedicated QSO column must be marked
// builtin. If one slips back to addable, an operator could add a custom field
// with the same name and the exporter would emit the tag twice — which ADIF
// forbids within a record.
func TestBuiltinFieldsAreNotExportable(t *testing.T) {
	// Mirrors the tags ExportADIF writes itself in internal/server/export.go.
	emitted := []string{
		"CALL", "NAME", "NAME_INTL", "QSO_DATE", "TIME_ON", "BAND", "FREQ",
		"MODE", "SUBMODE", "RST_SENT", "RST_RCVD", "STX", "SRX", "DARC_DOK",
		"GRIDSQUARE", "ITUZ", "CQZ", "SIG", "SIG_INFO", "OPERATOR",
		"STATION_CALLSIGN", "MY_GRIDSQUARE", "CONTEST_ID", "NOTES", "NOTES_INTL",
	}
	for _, tag := range emitted {
		f, ok := Lookup(tag)
		if !ok {
			t.Errorf("%s: emitted by the exporter but missing from the catalogue", tag)
			continue
		}
		if f.Status != StatusBuiltin && f.Status != StatusIntl {
			t.Errorf("%s: status %q, want builtin (or intl for a _INTL sibling)", tag, f.Status)
		}
		if _, ok := Exportable(tag); ok && f.Status == StatusBuiltin {
			t.Errorf("%s: Exportable returned true for a field the exporter already writes", tag)
		}
	}
}

func TestExportable(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"POTA_REF", true},
		{"pota_ref", true},    // case-insensitive
		{"MY_SIG_INTL", true}, // a UTF-8 sibling stays exportable under its own tag
		{"CALL", false},       // builtin
		{"GUEST_OP", false},   // deprecated
		{"VE_PROV", false},    // deprecated
		{"NOT_AN_ADIF_TAG", false},
	} {
		if _, got := Exportable(tc.name); got != tc.want {
			t.Errorf("Exportable(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestNormalize(t *testing.T) {
	field := func(name string) *Field {
		f, ok := Lookup(name)
		if !ok {
			t.Fatalf("%s missing from catalogue", name)
		}
		return f
	}
	for _, tc := range []struct {
		field string
		in    string
		want  string
	}{
		// Dates arrive from the native date picker as YYYY-MM-DD.
		{"QSLSDATE", "2026-03-22", "20260322"},
		{"QSLSDATE", "20260322", "20260322"},
		{"QSLSDATE", " 2026-03-22 ", "20260322"},
		{"QSLSDATE", "not a date", ""},
		{"QSLSDATE", "", ""},
		// Times arrive as HH:MM (the native control omits seconds).
		{"TIME_OFF", "14:05", "140500"},
		{"TIME_OFF", "14:05:31", "140531"},
		{"TIME_OFF", "1405", "140500"},
		{"TIME_OFF", "nonsense", ""},
		// Booleans are Y/N on the wire whatever the operator typed.
		{"SILENT_KEY", "yes", "Y"},
		{"SILENT_KEY", "n", "N"},
		{"SILENT_KEY", "0", "N"},
		{"SILENT_KEY", "maybe", ""},
		// Everything else passes through, trimmed.
		{"POTA_REF", "  DL-0001  ", "DL-0001"},
		{"TX_PWR", "100", "100"},
	} {
		if got := Normalize(field(tc.field), tc.in); got != tc.want {
			t.Errorf("Normalize(%s, %q) = %q, want %q", tc.field, tc.in, got, tc.want)
		}
	}
	if got := Normalize(nil, " x "); got != "x" {
		t.Errorf("Normalize(nil, %q) = %q, want %q", " x ", got, "x")
	}
}
