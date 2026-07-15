package server

import (
	"bytes"
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
