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
	if err := ExportADIF(&buf, []store.QSO{sampleQSO()}, "Noctalum", "test", ""); err != nil {
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
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", ""); err != nil {
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
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", ""); err != nil {
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
		if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", ""); err != nil {
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
	var buf bytes.Buffer
	if err := ExportADIF(&buf, []store.QSO{q}, "Noctalum", "test", ""); err != nil {
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
