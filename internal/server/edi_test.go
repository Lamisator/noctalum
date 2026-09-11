package server

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

func ediQSO(call, op, band, loc string, minute int) store.QSO {
	return store.QSO{
		Time:        time.Date(2026, 9, 5, 14, minute, 0, 0, time.UTC),
		Callsign:    call,
		Band:        band,
		FreqHz:      144_300_000,
		Mode:        "SSB",
		RSTSent:     "59",
		RSTReceived: "57",
		NrSent:      minute + 1,
		NrReceived:  12,
		Locator:     loc,
		Operator:    op,
	}
}

func exportEDIString(t *testing.T, qsos []store.QSO, opts EDIExportOptions) string {
	t.Helper()
	if opts.ContestName == "" {
		opts.ContestName = "UKW Contest"
	}
	if opts.StationCall == "" {
		opts.StationCall = "DL0ABC"
	}
	if opts.QTH == "" {
		opts.QTH = "JO31AB"
	}
	var buf bytes.Buffer
	if err := ExportEDI(&buf, qsos, opts); err != nil {
		t.Fatalf("ExportEDI: %v", err)
	}
	return buf.String()
}

// ediHeaderValues returns the KEY=value header lines of an EDI file.
func ediHeaderValues(t *testing.T, out string) map[string]string {
	t.Helper()
	m := map[string]string{}
	for _, l := range strings.Split(out, "\r\n") {
		if l == "[Remarks]" {
			break
		}
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

func TestExportEDISingleOperator(t *testing.T) {
	qsos := []store.QSO{
		ediQSO("DL1AA", "DM2LAP", "2m", "JO40", 0),
		ediQSO("DL2BB", "dm2lap", "2m", "JO41", 5),
	}
	h := ediHeaderValues(t, exportEDIString(t, qsos, EDIExportOptions{}))
	if h["PSect"] != "SINGLE" {
		t.Errorf("PSect = %q, want SINGLE", h["PSect"])
	}
	if h["RCall"] != "DM2LAP" {
		t.Errorf("RCall = %q, want the sole operator DM2LAP", h["RCall"])
	}
	if h["MOpe1"] != "" || h["MOpe2"] != "" {
		t.Errorf("single-op entry lists operators: MOpe1=%q MOpe2=%q", h["MOpe1"], h["MOpe2"])
	}
}

func TestExportEDIMultiOperator(t *testing.T) {
	qsos := []store.QSO{
		ediQSO("DL1AA", "DM2LAP", "2m", "JO40", 0),
		ediQSO("DL2BB", "DL8AA", "2m", "JO41", 5),
		ediQSO("DL3CC", "DM2LAP", "2m", "JO42", 9),
	}
	hdr, err := normalizeEDIHeader(`{"rcall":"dm2lap","operators":"DK1XY, dl8aa"}`)
	if err != nil {
		t.Fatal(err)
	}
	h := ediHeaderValues(t, exportEDIString(t, qsos, EDIExportOptions{HeaderJSON: hdr}))
	if h["PSect"] != "MULTI" {
		t.Errorf("PSect = %q, want MULTI", h["PSect"])
	}
	if h["RCall"] != "DM2LAP" {
		t.Errorf("RCall = %q", h["RCall"])
	}
	// The responsible operator is left out; the QSO operator DL8AA and the
	// extra operator DK1XY are listed once each.
	if h["MOpe1"] != "DL8AA;DK1XY" {
		t.Errorf("MOpe1 = %q, want DL8AA;DK1XY", h["MOpe1"])
	}
}

// An extra operator alone turns a log with a single QSO operator into a
// multi-op entry — the shared-login case.
func TestExportEDIExtraOperatorMakesMulti(t *testing.T) {
	qsos := []store.QSO{ediQSO("DL1AA", "DM2LAP", "2m", "JO40", 0)}
	hdr, _ := normalizeEDIHeader(`{"operators":"DK1XY"}`)
	h := ediHeaderValues(t, exportEDIString(t, qsos, EDIExportOptions{HeaderJSON: hdr}))
	if h["PSect"] != "MULTI" || h["RCall"] != "DM2LAP" || h["MOpe1"] != "DK1XY" {
		t.Errorf("PSect=%q RCall=%q MOpe1=%q", h["PSect"], h["RCall"], h["MOpe1"])
	}
}

func TestExportEDIOperatorOverflow(t *testing.T) {
	var qsos []store.QSO
	calls := []string{"DL1AAA", "DL2BBB", "DL3CCC", "DL4DDD", "DL5EEE", "DL6FFF", "DL7GGG", "DL8HHH",
		"DL9III", "DK1JJJ", "DK2KKK", "DK3LLL", "DK4MMM", "DK5NNN", "DK6OOO", "DK7PPP", "DK8QQQ",
		"DK9RRR", "DJ1SSS", "DJ2TTT", "DJ3UUU", "DJ4VVV"}
	for i, c := range calls {
		qsos = append(qsos, ediQSO("OK1ZZ", c, "2m", "JO60", i))
	}
	out := exportEDIString(t, qsos, EDIExportOptions{})
	h := ediHeaderValues(t, out)
	if len("MOpe1="+h["MOpe1"]) > ediMaxLine {
		t.Errorf("MOpe1 line exceeds %d characters: %q", ediMaxLine, h["MOpe1"])
	}
	listed := strings.Split(h["MOpe1"]+";"+h["MOpe2"], ";")
	if len(listed) != len(calls)-1 {
		t.Errorf("listed %d operators, want %d (all but the responsible one): %v", len(listed), len(calls)-1, listed)
	}
}

func TestExportEDIHeaderFields(t *testing.T) {
	hdr, err := normalizeEDIHeader(`{
		"pexch":"h01","padr1":"Hügel 1","padr2":"12345 Berg","pclub":"dl0xyz",
		"rname":"Jörg Müller","rcall":"DM2LAP","radr1":"Straße 2","radr2":"",
		"rpoco":"54321","rcity":"Köln","rcoun":"Germany","rphon":"+49 221 0","rhbbs":"a@b.de",
		"stxeq":"IC-9700","spowe":"100","srxeq":"IC-9700","sante":"2x 9el",
		"santh_agl":"12","santh_asl":"-3","remarks":"Line one\nLine two"}`)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 9, 6, 0, 0, 0, 0, time.UTC)
	out := exportEDIString(t, []store.QSO{ediQSO("DL1AA", "DM2LAP", "2m", "JO40", 0)},
		EDIExportOptions{HeaderJSON: hdr, StartDate: &start, EndDate: &end})
	h := ediHeaderValues(t, out)
	want := map[string]string{
		"TDate": "20260905;20260906", "PCall": "DL0ABC", "PWWLo": "JO31AB", "PExch": "H01",
		"PAdr1": "Huegel 1", "PAdr2": "12345 Berg", "PBand": "144 MHz", "PClub": "DL0XYZ",
		"RName": "Joerg Mueller", "RCall": "DM2LAP", "RAdr1": "Strasse 2", "RPoCo": "54321",
		"RCity": "Koeln", "RCoun": "Germany", "RPhon": "+49 221 0", "RHBBS": "a@b.de",
		"STXEq": "IC-9700", "SPowe": "100", "SRXEq": "IC-9700", "SAnte": "2x 9el", "SAntH": "12;-3",
	}
	for k, v := range want {
		if h[k] != v {
			t.Errorf("%s = %q, want %q", k, h[k], v)
		}
	}
	if !strings.Contains(out, "[Remarks]\r\nLine one\r\nLine two\r\n[QSORecords;1]\r\n") {
		t.Errorf("remarks block wrong:\n%s", out)
	}
	for i, l := range strings.Split(strings.TrimSuffix(out, "\r\n"), "\r\n") {
		if strings.Contains(l, "\n") {
			t.Errorf("line %d is not CR LF terminated: %q", i, l)
		}
		for _, r := range l {
			if r > 126 {
				t.Errorf("line %d has non-ASCII %q", i, l)
				break
			}
		}
	}
}

func TestExportEDIReceivedExchange(t *testing.T) {
	q := ediQSO("DL1AA", "DM2LAP", "2m", "JO40", 0)
	q.DOK = "k07"
	q.Extras = `{"district":"abc"}`
	for field, want := range map[string]string{"dok": "K07", "district": "ABC", "": ""} {
		hdr, _ := normalizeEDIHeader(`{"exch_field":"` + field + `"}`)
		out := exportEDIString(t, []store.QSO{q}, EDIExportOptions{HeaderJSON: hdr})
		rec := strings.Split(strings.Split(out, "]\r\n")[len(strings.Split(out, "]\r\n"))-1], ";")
		if rec[8] != want {
			t.Errorf("exch_field %q: received exchange = %q, want %q", field, rec[8], want)
		}
	}
}

func TestNormalizeEDIHeaderRejectsBadInput(t *testing.T) {
	for _, in := range []string{
		`{"pexch":"TOOLONG"}`,
		`{"rcall":"not a call"}`,
		`{"operators":"DL1AA, ???"}`,
		`{"spowe":"100W"}`,
		`{"santh_agl":"-2"}`,
		`not json`,
	} {
		if _, err := normalizeEDIHeader(in); err == nil {
			t.Errorf("normalizeEDIHeader(%s) accepted invalid input", in)
		}
	}
	if got, err := normalizeEDIHeader(`{"padr1":"  ","remarks":""}`); err != nil || got != "" {
		t.Errorf("empty header stored as %q, %v; want \"\"", got, err)
	}
	got, err := normalizeEDIHeader(`{"operators":"dl1aa dl2bb;DL1AA"}`)
	if err != nil || got != `{"operators":"DL1AA, DL2BB"}` {
		t.Errorf("operators normalised to %s, %v", got, err)
	}
}
