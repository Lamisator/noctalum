package server

import (
	"bytes"
	"strings"
	"testing"

	"github.com/noctalum/noctalum/internal/adif"
	"github.com/noctalum/noctalum/internal/store"
)

// Every default in the source table must name a tag the ADIF catalogue
// actually defines — a typo here would silently produce a non-standard export.
func TestADIFSourceDefaultsAreRealTags(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range adifSourceFields {
		if seen[f.Key] {
			t.Errorf("%s: duplicate source field", f.Key)
		}
		seen[f.Key] = true
		if f.Default == "" {
			continue // deliberately not exported until mapped
		}
		if _, ok := adif.Lookup(f.Default); !ok {
			t.Errorf("%s: default tag %q is not an ADIF field", f.Key, f.Default)
		}
	}
}

func TestResolveADIFMapping(t *testing.T) {
	// No overrides: everything sits on its default.
	base := resolveADIFMapping("")
	if base["dok"] != "DARC_DOK" || base["lighthouse"] != "SIG_INFO" {
		t.Errorf("defaults not applied: %v", base)
	}
	if base["distance"] != "" {
		t.Errorf("distance should default to not-exported, got %q", base["distance"])
	}

	m := resolveADIFMapping(`{
		"lighthouse": "WWFF_REF",
		"distance":   "DISTANCE",
		"dok":        "",
		"itu":        "not_a_tag",
		"name":       "guest_op",
		"time":       "COMMENT",
		"unknown_field": "STATE"
	}`)
	if m["lighthouse"] != "WWFF_REF" {
		t.Errorf("override not applied: %q", m["lighthouse"])
	}
	if m["distance"] != "DISTANCE" {
		t.Errorf("opt-in field not switched on: %q", m["distance"])
	}
	// An empty value is the operator switching the field off, which is a
	// different thing from the key being absent.
	if m["dok"] != "" {
		t.Errorf("dok should be switched off, got %q", m["dok"])
	}
	// Garbage and import-only targets fall back to the default rather than
	// producing a file importers reject.
	if m["itu"] != "ITUZ" {
		t.Errorf("unknown tag should fall back to the default, got %q", m["itu"])
	}
	if m["name"] != "NAME" {
		t.Errorf("deprecated target should fall back to the default, got %q", m["name"])
	}
	// Fixed mappings ignore overrides entirely.
	if m["time"] != "QSO_DATE" {
		t.Errorf("fixed mapping must not be overridable, got %q", m["time"])
	}
	if _, ok := m["unknown_field"]; ok {
		t.Errorf("unknown source key leaked into the resolved mapping")
	}

	// Malformed JSON degrades to defaults instead of erroring the export.
	if got := resolveADIFMapping("{not json"); got["dok"] != "DARC_DOK" {
		t.Errorf("malformed mapping should degrade to defaults, got %q", got["dok"])
	}
}

// The headline case: an operator running a WWFF activation wants the
// Lighthouse column to carry their WWFF reference instead.
func TestExportADIFHonoursRemappedField(t *testing.T) {
	q := sampleQSO()
	q.Lighthouse = "DLFF-0042"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		MappingJSON: `{"lighthouse":"WWFF_REF"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<WWFF_REF:9>DLFF-0042") {
		t.Errorf("re-mapped value missing: %q", out)
	}
	// The SIG=ARLHS companion only belongs with the default SIG_INFO mapping;
	// next to WWFF_REF it would claim the wrong programme.
	if strings.Contains(out, "ARLHS") || strings.Contains(out, "<SIG_INFO:") {
		t.Errorf("default lighthouse tags leaked into a re-mapped export: %q", out)
	}
}

// Switching a field off must remove it from the file, not blank it.
func TestExportADIFSuppressedFieldIsOmitted(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		MappingJSON: `{"dok":"","name":""}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	for _, tag := range []string{"<DARC_DOK:", "<NAME:", "<NAME_INTL:"} {
		if strings.Contains(out, tag) {
			t.Errorf("%s emitted for a field the operator switched off: %q", tag, out)
		}
	}
	if !strings.Contains(out, "<CALL:5>DL8AA") {
		t.Errorf("switching one field off must not disturb the rest: %q", out)
	}
}

// Distance is computed from the two locators and off by default; mapping it
// switches it on without anyone else's export changing.
func TestExportADIFDistanceIsOptIn(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test", MyGridsquare: "JN49XX",
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	if strings.Contains(buf.String(), "<DISTANCE:") {
		t.Errorf("DISTANCE must stay off until mapped: %q", buf.String())
	}
	buf.Reset()
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test", MyGridsquare: "JN49XX",
		MappingJSON: `{"distance":"DISTANCE"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	if !strings.Contains(buf.String(), "<DISTANCE:") {
		t.Errorf("DISTANCE missing after mapping it on: %q", buf.String())
	}
}

// Two source fields pointed at one tag cannot both be written: ADIF forbids a
// field name appearing twice in a record. The first one in export order wins.
func TestExportADIFRemapCollisionEmitsOnce(t *testing.T) {
	q := sampleQSO()
	q.DOK = "H01"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		MappingJSON: `{"dok":"COMMENT","lighthouse":"COMMENT"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	if n := strings.Count(buf.String(), "<COMMENT:"); n != 1 {
		t.Errorf("COMMENT emitted %d times, want exactly 1: %q", n, buf.String())
	}
}

// Re-mapping a field must still get the target tag's data-type treatment —
// the value has to suit its new home, not its old one.
func TestExportADIFRemapAppliesTargetFieldRules(t *testing.T) {
	q := sampleQSO()
	q.Notes = "Grüße aus München"
	q.ContestName = ""
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		MappingJSON: `{"notes":"QSLMSG"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<QSLMSG_INTL:") {
		t.Errorf("non-ASCII value should move to the target's _INTL sibling: %q", out)
	}
	if strings.Contains(out, "<NOTES") {
		t.Errorf("notes still on their default tag after re-mapping: %q", out)
	}
}

// Re-pointing the contest name stops it hijacking NOTES: the operator asked
// for it somewhere specific, so that is where it goes, enum value or not.
func TestExportADIFRemappedContestNameSkipsNotesFallback(t *testing.T) {
	q := sampleQSO()
	q.ContestName = "WSA 2026" // not an ADIF CONTEST_ID enum value
	q.Notes = "S9 into JN49"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		MappingJSON: `{"contest_name":"STX_STRING"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<STX_STRING:8>WSA 2026") {
		t.Errorf("contest name missing from its mapped tag: %q", out)
	}
	if strings.Contains(out, "Contest: WSA 2026") {
		t.Errorf("NOTES fallback fired for a re-mapped contest name: %q", out)
	}
	if !strings.Contains(out, "<NOTES:12>S9 into JN49") {
		t.Errorf("operator notes should be left alone: %q", out)
	}
}

// A custom field can be pointed at a standard ADIF tag without renaming it, so
// an operator whose exchange column is called "Region" can export it as STATE
// while the QSO mask keeps saying "Region".
func TestExportADIFCustomFieldMapping(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"Region":"NY","Club":"OV L01","Secret":"hidden"}`
	cfJSON := `[{"name":"Region"},{"name":"Club"},{"name":"Secret"}]`
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		CustomFieldsJSON: cfJSON,
		MappingJSON:      `{"cf:Region":"STATE","cf:Secret":""}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<STATE:2>NY") {
		t.Errorf("mapped custom field should land on its chosen tag: %q", out)
	}
	// "Region" would otherwise land on ADIF's own REGION tag (WAE/CQ region),
	// which is exactly the confusion an explicit mapping exists to resolve.
	if strings.Contains(out, "<REGION:") {
		t.Errorf("mapped custom field must not also emit its name-derived tag: %q", out)
	}
	// Unmapped custom fields keep the historical name-derived behaviour.
	if !strings.Contains(out, "<APP_NOCTALUM_CLUB:6>OV L01") {
		t.Errorf("unmapped custom field should keep the APP_ fallback: %q", out)
	}
	// An empty mapping value switches the field off entirely.
	if strings.Contains(out, "hidden") || strings.Contains(out, "SECRET") {
		t.Errorf("custom field switched off in the mapping was still exported: %q", out)
	}
}

// Mapping a custom field must give it the target tag's data-type treatment,
// not the one its own name would have implied.
func TestExportADIFCustomFieldMappingAppliesTargetRules(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"Worked from":"München","Logged on":"2026-03-22"}`
	cfJSON := `[{"name":"Worked from"},{"name":"Logged on"}]`
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		CustomFieldsJSON: cfJSON,
		MappingJSON:      `{"cf:Worked from":"MY_CITY","cf:Logged on":"QSLSDATE"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<MY_CITY_INTL:8>München") {
		t.Errorf("non-ASCII value should move to the target's _INTL sibling: %q", out)
	}
	if !strings.Contains(out, "<QSLSDATE:8>20260322") {
		t.Errorf("value should be normalised to the target's ADIF data type: %q", out)
	}
}

// A custom field mapped onto a tag a built-in field already occupies must not
// produce a second Data Specifier — ADIF forbids that inside one record.
func TestExportADIFCustomFieldMappingCollision(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"Region":"NY"}`
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		CustomFieldsJSON: `[{"name":"Region"}]`,
		MappingJSON:      `{"cf:Region":"DARC_DOK"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if n := strings.Count(out, "<DARC_DOK:"); n != 1 {
		t.Errorf("DARC_DOK emitted %d times, want exactly 1: %q", n, out)
	}
	// The built-in DOK column is written first, so it wins.
	if !strings.Contains(out, "<DARC_DOK:3>H01") {
		t.Errorf("the built-in field should win the collision: %q", out)
	}
}

// A mapping override naming something that is not an addressable tag is
// ignored, leaving the custom field on its name-derived default.
func TestExportADIFCustomFieldMappingRejectsBadTarget(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"Club night":"Tuesday"}`
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, ADIFExportOptions{
		ProgramID: "Noctalum", ProgramVersion: "test",
		CustomFieldsJSON: `[{"name":"Club night"}]`,
		MappingJSON:      `{"cf:Club night":"not_a_tag"}`,
	}); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	if !strings.Contains(buf.String(), "<APP_NOCTALUM_CLUB_NIGHT:7>Tuesday") {
		t.Errorf("bad target should fall back to the name-derived default: %q", buf.String())
	}
}
