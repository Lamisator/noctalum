package server

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

// sampleQSO returns a QSO with every field a contest exchange typically
// carries — used as a fixture across ADIF/CSV export tests.
func sampleQSO() store.QSO {
	return store.QSO{
		ID:          42,
		Time:        time.Date(2026, 6, 1, 12, 34, 56, 0, time.UTC),
		Callsign:    "DL8AA",
		Name:        "Jörg",
		Band:        "40m",
		FreqHz:      7_050_000,
		Mode:        "SSB",
		RSTSent:     "59",
		RSTReceived: "59",
		NrSent:      17,
		NrReceived:  23,
		DOK:         "H01",
		Locator:     "JO52",
		Operator:    "DM2LAP",
		StationCall: "DM2LAP",
		Notes:       "test note",
		ContestName: "WSA 2026",
	}
}

// FR #67 (dl8aa): contest exchange numbers were silently dropped from the
// ADIF export. Verify STX and SRX are emitted for QSOs that carry sequence
// numbers, and omitted for QSOs that don't.
func TestExportADIFEmitsSTXSRX(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<STX:2>17") {
		t.Errorf("STX (sent number) missing or wrong length: %q", out)
	}
	if !strings.Contains(out, "<SRX:2>23") {
		t.Errorf("SRX (received number) missing or wrong length: %q", out)
	}
}

func TestExportADIFOmitsSTXSRXWhenZero(t *testing.T) {
	q := sampleQSO()
	q.NrSent = 0
	q.NrReceived = 0
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "<STX:") || strings.Contains(out, "<SRX:") {
		t.Errorf("STX/SRX leaked into non-contest QSO: %q", out)
	}
}

// FR #67: bare <ARLHS> is not a standard ADIF field. Verify lighthouse
// references are exported via the idiomatic SIG=ARLHS + SIG_INFO=<ref> pair.
func TestExportADIFLighthouseUsesSIG(t *testing.T) {
	q := sampleQSO()
	q.Lighthouse = "DE-0042"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "<ARLHS:") {
		t.Errorf("bare <ARLHS> still emitted (non-standard): %q", out)
	}
	if !strings.Contains(out, "<SIG:5>ARLHS") {
		t.Errorf("SIG=ARLHS missing: %q", out)
	}
	if !strings.Contains(out, "<SIG_INFO:7>DE-0042") {
		t.Errorf("SIG_INFO=<ref> missing: %q", out)
	}
}

// FR #67: FT8/FT4 are SUBMODEs of MFSK per ADIF 3.1.5, PSK31 is a SUBMODE
// of PSK. Emitting MODE=FT8 directly makes strict validators reject.
func TestExportADIFModeSubmodeSplit(t *testing.T) {
	cases := []struct {
		in           string
		wantMode     string
		wantSubmode  string
		wantNoSubmod bool
	}{
		{"FT8", "MFSK", "FT8", false},
		{"FT4", "MFSK", "FT4", false},
		{"PSK31", "PSK", "PSK31", false},
		{"PSK63", "PSK", "PSK63", false},
		{"CW", "CW", "", true},
		{"SSB", "SSB", "", true},
		{"USB", "SSB", "USB", false},
		{"FM", "FM", "", true},
	}
	for _, c := range cases {
		q := sampleQSO()
		q.Mode = c.in
		var buf bytes.Buffer
		if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
			t.Fatalf("ExportADIF(%s): %v", c.in, err)
		}
		out := buf.String()
		wantModeTag := "<MODE:" + strconv.Itoa(len(c.wantMode)) + ">" + c.wantMode
		if !strings.Contains(out, wantModeTag) {
			t.Errorf("Mode %q: missing %s in output %q", c.in, wantModeTag, out)
		}
		if c.wantNoSubmod {
			if strings.Contains(out, "<SUBMODE:") {
				t.Errorf("Mode %q: unexpected SUBMODE emitted: %q", c.in, out)
			}
			continue
		}
		wantSub := "<SUBMODE:" + strconv.Itoa(len(c.wantSubmode)) + ">" + c.wantSubmode
		if !strings.Contains(out, wantSub) {
			t.Errorf("Mode %q: missing %s in output %q", c.in, wantSub, out)
		}
	}
}

// FR #67: free-form notes belong in NOTES (general operator remarks), not
// COMMENT (which ADIF reserves for QSO-relevant metadata like signal
// conditions).
func TestExportADIFUsesNOTESNotCOMMENT(t *testing.T) {
	q := sampleQSO()
	q.Notes = "hello world"
	q.ContestName = "" // don't let the contest-name fallback rewrite NOTES
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "<COMMENT:") {
		t.Errorf("COMMENT still emitted for freeform notes: %q", out)
	}
	if !strings.Contains(out, "<NOTES:11>hello world") {
		t.Errorf("NOTES tag missing: %q", out)
	}
}

// FR #67: CONTEST_ID must contain a valid ADIF enum value. A recognised
// contest name maps to its canonical form (case- and hyphen-insensitive);
// an unknown contest name falls back to being prepended to NOTES so
// strict validators (DXKeeper, Log4OM, LotW) don't reject the record.
func TestExportADIFContestIDEnumLookup(t *testing.T) {
	cases := []struct {
		in      string
		wantTag string
	}{
		{"IARU-HF", "<CONTEST_ID:7>IARU-HF"},
		{"iaru hf", "<CONTEST_ID:7>IARU-HF"},   // case + separator insensitive
		{"CQ-WW-CW", "<CONTEST_ID:8>CQ-WW-CW"}, // exact match
		{"cqww ssb", "<CONTEST_ID:9>CQ-WW-SSB"},
	}
	for _, c := range cases {
		q := sampleQSO()
		q.ContestName = c.in
		q.Notes = "" // start clean so we can assert NOTES isn't touched
		var buf bytes.Buffer
		if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
			t.Fatalf("ExportADIF(%q): %v", c.in, err)
		}
		out := buf.String()
		if !strings.Contains(out, c.wantTag) {
			t.Errorf("Contest %q: expected %q in %q", c.in, c.wantTag, out)
		}
		if strings.Contains(out, "<NOTES:") {
			t.Errorf("Contest %q: NOTES should not be touched when CONTEST_ID matches: %q", c.in, out)
		}
	}
}

func TestExportADIFUnknownContestFallsBackToNOTES(t *testing.T) {
	q := sampleQSO()
	q.ContestName = "WSA 2026" // local DARC OV activity — not in ADIF enum
	q.Notes = ""
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "<CONTEST_ID:") {
		t.Errorf("CONTEST_ID must be omitted for unknown contest names: %q", out)
	}
	if !strings.Contains(out, "Contest: WSA 2026") {
		t.Errorf("unknown contest name must fall back to NOTES: %q", out)
	}
}

func TestExportADIFUnknownContestPreservesExistingNotes(t *testing.T) {
	q := sampleQSO()
	q.ContestName = "Local Fun Run"
	q.Notes = "S9+20 into JN49"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	// ADIF 3.1.5 MultilineString line breaks must be CR/LF, so the prefix
	// / notes join uses "\r\n" — not bare "\n".
	if !strings.Contains(out, "Contest: Local Fun Run\r\nS9+20 into JN49") {
		t.Errorf("existing NOTES must be preserved after the contest fallback: %q", out)
	}
}

// FR #67: MY_GRIDSQUARE is required by every award tracker to credit
// worked-grids/DXCC-from-here. It was previously never emitted.
func TestExportADIFEmitsMyGridsquare(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, "Noctalum", "test", "", "jn49xx"); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	// Locator gets uppercased so LotW/eQSL accept it verbatim.
	if !strings.Contains(out, "<MY_GRIDSQUARE:6>JN49XX") {
		t.Errorf("MY_GRIDSQUARE missing or wrong case: %q", out)
	}
}

func TestExportADIFOmitsMyGridsquareWhenEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	if strings.Contains(buf.String(), "<MY_GRIDSQUARE:") {
		t.Errorf("MY_GRIDSQUARE must not appear when caller passes empty QTH")
	}
}

// FR #67: ADIF `NAME` is ASCII-only. Names with umlauts / accents must be
// emitted via the `NAME_INTL` sibling field so importers UTF-8-decode.
func TestExportADIFNameIntlForUmlauts(t *testing.T) {
	q := sampleQSO() // Name: "Jörg"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	// "Jörg" is 5 bytes in UTF-8 (ö = 0xC3 0xB6).
	if !strings.Contains(out, "<NAME_INTL:5>Jörg") {
		t.Errorf("NAME_INTL missing for umlaut name: %q", out)
	}
	// Plain <NAME> would misrepresent the byte count on a strict reader.
	if strings.Contains(out, "<NAME:") {
		t.Errorf("plain <NAME> emitted for non-ASCII value: %q", out)
	}
}

func TestExportADIFNamePlainForASCII(t *testing.T) {
	q := sampleQSO()
	q.Name = "Carsten"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<NAME:7>Carsten") {
		t.Errorf("plain <NAME> missing for ASCII value: %q", out)
	}
	if strings.Contains(out, "<NAME_INTL:") {
		t.Errorf("NAME_INTL wrongly emitted for ASCII value: %q", out)
	}
}

// Same _INTL / ASCII split applies to NOTES.
func TestExportADIFNotesIntlForUmlauts(t *testing.T) {
	q := sampleQSO()
	q.ContestName = "" // avoid the "Contest:" prefix polluting the notes
	q.Notes = "schöner Kontakt"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<NOTES_INTL:") {
		t.Errorf("NOTES_INTL missing for umlaut notes: %q", out)
	}
	if strings.Contains(out, "<NOTES:") {
		t.Errorf("plain <NOTES> emitted for non-ASCII value: %q", out)
	}
}

// FR #67 (dl8aa): the header must declare ADIF 3.1.5, because we emit
// IntlString length as a *byte* count — that is only spec-conformant from
// 3.1.5 onwards (earlier versions define the length as character count).
func TestExportADIFHeaderVersion(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<ADIF_VER:5>3.1.5") {
		t.Errorf("ADIF_VER must be 3.1.5 to match our byte-length IntlString emission: %q", out)
	}
}

// The partner's GRIDSQUARE should be uppercased so it matches the LotW /
// eQSL / DXCC convention and round-trips through those services without
// case-normalisation surprises.
func TestExportADIFUppercasesGridsquare(t *testing.T) {
	q := sampleQSO()
	q.Locator = "jo52ab"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "<GRIDSQUARE:6>JO52AB") {
		t.Errorf("GRIDSQUARE must be uppercased in ADIF output: %q", out)
	}
	if strings.Contains(out, "jo52ab") {
		t.Errorf("lowercase locator leaked into GRIDSQUARE: %q", out)
	}
}

// A custom field named after a standard ADIF tag (e.g. STATE, POTA_REF)
// should be emitted as that standard tag, NOT wrapped in
// APP_<PROGRAMID>_ — otherwise award trackers (LotW, POTA, eQSL) never
// see the value under the tag they actually query.
func TestExportADIFCustomFieldPromotedToStandardTag(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"State":"NY","MyClub":"OV L01"}`
	cfJSON := `[{"name":"State","type":"text"},{"name":"MyClub","type":"text"}]`
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", cfJSON, ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	// STATE is a standard ADIF tag — emit as-is.
	if !strings.Contains(out, "<STATE:2>NY") {
		t.Errorf("custom field 'State' should emit as standard <STATE> tag: %q", out)
	}
	if strings.Contains(out, "APP_NOCTALUM_STATE") {
		t.Errorf("custom field 'State' must NOT double up as APP_NOCTALUM_STATE: %q", out)
	}
	// MyClub is not standard — must fall back to APP_ prefix.
	if !strings.Contains(out, "<APP_NOCTALUM_MYCLUB:6>OV L01") {
		t.Errorf("non-standard custom field must use APP_ prefix: %q", out)
	}
}

// Bare LF line endings inside NOTES violate ADIF 3.1.5
// MultilineString semantics — normaliseCRLF must upgrade them to CR/LF
// before emission (regardless of whether the source used LF, CR, or CRLF).
func TestExportADIFNotesLineEndingsAreCRLF(t *testing.T) {
	q := sampleQSO()
	q.ContestName = "" // don't let the contest fallback rewrite NOTES
	q.Notes = "line one\nline two\rline three\r\nline four"
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", "", ""); err != nil {
		t.Fatalf("ExportADIF: %v", err)
	}
	out := buf.String()
	want := "line one\r\nline two\r\nline three\r\nline four"
	if !strings.Contains(out, want) {
		t.Errorf("NOTES line endings must all be CR/LF: %q", out)
	}
}

// FR #67 (dl8aa): CSV must include nr_sent / nr_received columns so contest
// operators can pivot on the sequence number in spreadsheets.
func TestExportCSVIncludesNRColumns(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportCSV(&buf, []store.QSO{sampleQSO()}, ""); err != nil {
		t.Fatalf("ExportCSV: %v", err)
	}
	out := buf.String()
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		t.Fatalf("expected at least header + row, got %d lines", len(lines))
	}
	header := lines[0]
	if !strings.Contains(header, "nr_sent") || !strings.Contains(header, "nr_received") {
		t.Errorf("CSV header missing nr_sent/nr_received: %q", header)
	}
	row := lines[1]
	// The row must carry the actual values, not empty strings.
	if !strings.Contains(row, ",17,") || !strings.Contains(row, ",23,") {
		t.Errorf("CSV row missing NR values (17,23): %q", row)
	}
}
