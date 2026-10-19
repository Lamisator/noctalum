package server

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/noctalum/noctalum/internal/store"
)

func cabrilloOpts(mapping, customFields string) CabrilloExportOptions {
	return CabrilloExportOptions{
		ContestName:      "WSA 2026",
		StationCall:      "DM2LAP",
		MyGridsquare:     "JO52AB",
		CustomFieldsJSON: customFields,
		MappingJSON:      mapping,
	}
}

// The historical QSO-line format, reproduced verbatim from the pre-mapping
// exporter. A contest with no mapping must still produce exactly this, down to
// the trailing padding on the last column.
func historicalCabrilloLine(q store.QSO, stationCall string) string {
	t := q.Time.UTC()
	return fmt.Sprintf("QSO: %5d %2s %s %04s %-13s %-3s %-6s %-13s %-3s %-6s",
		q.FreqHz/1000, cabrilloMode(q.Mode), t.Format("2006-01-02"), t.Format("1504"),
		strings.ToUpper(stationCall), q.RSTSent, q.ITUZone,
		strings.ToUpper(q.Callsign), q.RSTReceived, q.CQZone)
}

func TestExportCabrilloDefaultIsByteIdenticalToHistoricalFormat(t *testing.T) {
	q := sampleQSO()
	q.ITUZone = "28"
	q.CQZone = "14"
	var buf bytes.Buffer
	if err := ExportCabrillo(&buf, []store.QSO{q}, cabrilloOpts("", "")); err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	want := historicalCabrilloLine(q, "DM2LAP")
	if !strings.Contains(buf.String(), want+"\n") {
		t.Errorf("default output drifted from the historical format\n want: %q\n got:  %q", want, buf.String())
	}
}

func TestExportCabrilloHeader(t *testing.T) {
	var buf bytes.Buffer
	if err := ExportCabrillo(&buf, []store.QSO{sampleQSO()}, cabrilloOpts("", "")); err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"START-OF-LOG: 3.0", "CREATED-BY: Noctalum",
		"CONTEST: WSA 2026", "CALLSIGN: DM2LAP", "END-OF-LOG:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing header line %q in %q", want, out)
		}
	}
}

func TestResolveCabrilloMapping(t *testing.T) {
	sent, rcvd := resolveCabrilloMapping("", nil)
	if strings.Join(sent, ",") != "rst_sent,itu" || strings.Join(rcvd, ",") != "rst_received,cq" {
		t.Errorf("empty blob should give the historical layout, got %v / %v", sent, rcvd)
	}
	if got, _ := resolveCabrilloMapping("{not json", nil); strings.Join(got, ",") != "rst_sent,itu" {
		t.Errorf("malformed blob should degrade to the default, got %v", got)
	}

	cfs := []customFieldDef{{Name: "Region"}}
	sent, rcvd = resolveCabrilloMapping(
		`{"sent":["rst_sent","nr_sent","bogus"],"received":["rst_received","nr_received","cf:Region","cf:Gone"]}`, cfs)
	if strings.Join(sent, ",") != "rst_sent,nr_sent" {
		t.Errorf("unknown key should be dropped from the sent exchange, got %v", sent)
	}
	// A custom field that no longer exists is dropped rather than written as an
	// empty column, which would shift every following field out of position.
	if strings.Join(rcvd, ",") != "rst_received,nr_received,cf:Region" {
		t.Errorf("stale custom field should be dropped, got %v", rcvd)
	}

	// An empty exchange on one side is a legitimate choice, not a reason to
	// fall back to the default.
	sent, rcvd = resolveCabrilloMapping(`{"sent":[],"received":["rst_received"]}`, nil)
	if len(sent) != 0 || strings.Join(rcvd, ",") != "rst_received" {
		t.Errorf("empty sent exchange should be honoured, got %v / %v", sent, rcvd)
	}
}

// The headline case: a serial-number contest sends RST + serial and receives
// RST + serial, which the historical hardcoded ITU/CQ layout could not express.
func TestExportCabrilloSerialExchange(t *testing.T) {
	q := sampleQSO()
	var buf bytes.Buffer
	err := ExportCabrillo(&buf, []store.QSO{q}, cabrilloOpts(
		`{"sent":["rst_sent","nr_sent"],"received":["rst_received","nr_received"]}`, ""))
	if err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	line := qsoLine(t, buf.String())
	if !strings.Contains(line, "DM2LAP        59  017    DL8AA         59  023") {
		t.Errorf("serial exchange not laid out as expected: %q", line)
	}
}

// A per-QSO custom field can fill an exchange slot — the point of the whole
// exercise for contests whose exchange Noctalum has no built-in column for.
func TestExportCabrilloCustomFieldInExchange(t *testing.T) {
	q := sampleQSO()
	q.Extras = `{"Region":"BY","Club":"OV L01"}`
	var buf bytes.Buffer
	err := ExportCabrillo(&buf, []store.QSO{q}, cabrilloOpts(
		`{"sent":["rst_sent","cf:Club"],"received":["rst_received","cf:Region"]}`,
		`[{"name":"Region"},{"name":"Club"}]`))
	if err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	line := qsoLine(t, buf.String())
	// "OV L01" would become two whitespace-delimited columns and shift every
	// following field, so the space collapses to a hyphen.
	if !strings.Contains(line, "OV-L01") {
		t.Errorf("custom field with a space must be collapsed to one token: %q", line)
	}
	if !strings.Contains(line, "BY") {
		t.Errorf("received custom field missing: %q", line)
	}
}

func TestCabrilloToken(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"  by  ", "BY"},
		{"OV L01", "OV-L01"},
		{"a  b   c", "A-B-C"},
		// Cabrillo is ASCII-only, so non-ASCII runes are dropped. Go uses
		// simple case mapping, so ß stays ß and is dropped along with ü —
		// mangling the operator can see and correct in their data.
		{"Grüße", "GRE"},
		{"trailing ", "TRAILING"},
		{"\ttab\tsep\t", "TAB-SEP"},
	} {
		if got := cabrilloToken(tc.in); got != tc.want {
			t.Errorf("cabrilloToken(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// qsoLine returns the single QSO: line from a Cabrillo export, failing the
// test if there isn't exactly one.
func qsoLine(t *testing.T, out string) string {
	t.Helper()
	var found []string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "QSO:") {
			found = append(found, l)
		}
	}
	if len(found) != 1 {
		t.Fatalf("expected exactly one QSO line, got %d in %q", len(found), out)
	}
	return found[0]
}

func TestExportCabrilloFallsBackToBandFrequencyWithoutQRG(t *testing.T) {
	cases := []struct {
		band, want string
	}{
		{"40m", "QSO:  7000 PH "},
		{"20m", "QSO: 14000 PH "},
		{"2m", "QSO:   144 PH "},
		{"23cm", "QSO:  1.2G PH "},
		{"", "QSO:     0 PH "},
	}
	for _, c := range cases {
		q := sampleQSO()
		q.FreqHz = 0
		q.Band = c.band
		var buf bytes.Buffer
		if err := ExportCabrillo(&buf, []store.QSO{q}, cabrilloOpts("", "")); err != nil {
			t.Fatalf("ExportCabrillo: %v", err)
		}
		if !strings.Contains(buf.String(), "\n"+c.want) {
			t.Errorf("band %q: want a line starting %q, got:\n%s", c.band, c.want, buf.String())
		}
	}
}

func TestExportCabrilloWAGExchange(t *testing.T) {
	opts := cabrilloOpts(`{"sent":["rst_sent","my_dok"],"received":["rst_received","dok_or_nr"]}`, "")
	opts.MyDOK = "P01"

	dl := sampleQSO()
	dl.Callsign, dl.DOK, dl.NrReceived = "DK2XYZ", "b36", 0
	dx := sampleQSO()
	dx.Callsign, dx.DOK, dx.NrReceived = "OK1AA", "", 7
	nm := sampleQSO()
	nm.Callsign, nm.DOK, nm.NrReceived = "DL9QQ", "NM", 12
	none := sampleQSO()
	none.Callsign, none.DOK, none.NrReceived = "DL7ZZ", "", 0

	var buf bytes.Buffer
	if err := ExportCabrillo(&buf, []store.QSO{dl, dx, nm, none}, opts); err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"DM2LAP        59  P01    DK2XYZ        59  B36   \n",
		"DM2LAP        59  P01    OK1AA         59  007   \n",
		// A logged DOK wins over the serial, and NM is kept as typed.
		"DM2LAP        59  P01    DL9QQ         59  NM    \n",
		// Neither logged: an empty column, never an invented "NM".
		"DM2LAP        59  P01    DL7ZZ         59        \n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing line ending %q in:\n%s", want, out)
		}
	}
}

func TestNormalizeMyDOK(t *testing.T) {
	for in, want := range map[string]string{" p01 ": "P01", "": "", "50jdarc": "50JDARC"} {
		got, err := normalizeMyDOK(in)
		if err != nil || got != want {
			t.Errorf("normalizeMyDOK(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"P 01", "P-01", "ÄB1", "ABCDEFGHIJKLM"} {
		if _, err := normalizeMyDOK(bad); err == nil {
			t.Errorf("normalizeMyDOK(%q) accepted", bad)
		}
	}
}

func TestExportCabrilloSerialsPadWithoutCappingWidth(t *testing.T) {
	q := sampleQSO()
	q.NrSent, q.NrReceived = 5, 1234
	var buf bytes.Buffer
	err := ExportCabrillo(&buf, []store.QSO{q}, cabrilloOpts(
		`{"sent":["rst_sent","nr_sent"],"received":["rst_received","nr_received"]}`, ""))
	if err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	if line := qsoLine(t, buf.String()); !strings.Contains(line, "59  005    DL8AA         59  1234") {
		t.Errorf("serials not padded as expected: %q", line)
	}
}

func TestExportCabrilloEmptyReceivedNumberAsZeros(t *testing.T) {
	missing := sampleQSO()
	missing.NrReceived, missing.DOK = 0, ""
	for _, c := range []struct {
		mapping, want string
	}{
		// Off (default): the column stays empty.
		{`{"sent":["rst_sent"],"received":["rst_received","nr_received"]}`, "DL8AA         59        "},
		{`{"sent":["rst_sent"],"received":["rst_received","nr_received"],"empty_nr_zero":true}`, "DL8AA         59  000   "},
		// dok_or_nr: no DOK and no serial -> 000, but never "NM".
		{`{"sent":["rst_sent"],"received":["rst_received","dok_or_nr"],"empty_nr_zero":true}`, "DL8AA         59  000   "},
	} {
		var buf bytes.Buffer
		if err := ExportCabrillo(&buf, []store.QSO{missing}, cabrilloOpts(c.mapping, "")); err != nil {
			t.Fatalf("ExportCabrillo: %v", err)
		}
		if line := qsoLine(t, buf.String()); !strings.HasSuffix(line, c.want) {
			t.Errorf("%s: want line ending %q, got %q", c.mapping, c.want, line)
		}
	}

	// A logged serial or DOK is never replaced by zeros.
	logged := sampleQSO()
	logged.NrReceived, logged.DOK = 0, "B36"
	var buf bytes.Buffer
	if err := ExportCabrillo(&buf, []store.QSO{logged}, cabrilloOpts(
		`{"sent":["rst_sent"],"received":["rst_received","dok_or_nr"],"empty_nr_zero":true}`, "")); err != nil {
		t.Fatalf("ExportCabrillo: %v", err)
	}
	if line := qsoLine(t, buf.String()); !strings.HasSuffix(line, "59  B36   ") {
		t.Errorf("logged DOK overwritten: %q", line)
	}
}

func TestExportCabrilloContestHeaderName(t *testing.T) {
	for _, c := range []struct {
		mapping, want string
	}{
		{"", "CONTEST: WSA 2026\n"},
		{`{"sent":["rst_sent"],"received":["rst_received"]}`, "CONTEST: WSA 2026\n"},
		{`{"sent":["rst_sent"],"received":["rst_received"],"contest":"DARC-WAG"}`, "CONTEST: DARC-WAG\n"},
		{`{"sent":["rst_sent"],"received":["rst_received"],"contest":" darc wag "}`, "CONTEST: DARC-WAG\n"},
		{`{"sent":["rst_sent"],"received":["rst_received"],"contest":"   "}`, "CONTEST: WSA 2026\n"},
	} {
		var buf bytes.Buffer
		if err := ExportCabrillo(&buf, []store.QSO{sampleQSO()}, cabrilloOpts(c.mapping, "")); err != nil {
			t.Fatalf("ExportCabrillo: %v", err)
		}
		if !strings.Contains(buf.String(), c.want) {
			t.Errorf("mapping %s: want %q in\n%s", c.mapping, c.want, buf.String())
		}
	}
}
