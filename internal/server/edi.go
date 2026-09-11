package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/noctalum/noctalum/internal/store"
)

// EDIHeader carries the REG1TEST (IARU Region 1 EDI) header lines that
// Noctalum cannot derive from the log itself: the address the station
// operated from, the responsible operator's contact details, the equipment
// and a free remarks block. It is stored per contest as JSON in
// contests.edi_header; the JSON keys are the REG1TEST keywords in lower case
// so a stored value reads like the file it produces.
//
// Everything else in the header — call, locator, band, section, operators,
// dates and the claimed totals — comes from the contest and its QSOs.
type EDIHeader struct {
	PExch    string `json:"pexch,omitempty"` // own exchange, at most 6 characters
	PAdr1    string `json:"padr1,omitempty"` // address the contest was operated from
	PAdr2    string `json:"padr2,omitempty"`
	PClub    string `json:"pclub,omitempty"` // club the points go to
	RName    string `json:"rname,omitempty"` // responsible operator
	RCall    string `json:"rcall,omitempty"`
	RAdr1    string `json:"radr1,omitempty"`
	RAdr2    string `json:"radr2,omitempty"`
	RPoCo    string `json:"rpoco,omitempty"`
	RCity    string `json:"rcity,omitempty"`
	RCoun    string `json:"rcoun,omitempty"`
	RPhon    string `json:"rphon,omitempty"`
	RHBBS    string `json:"rhbbs,omitempty"` // home BBS or e-mail
	STXEq    string `json:"stxeq,omitempty"`
	SPowe    string `json:"spowe,omitempty"` // watts
	SRXEq    string `json:"srxeq,omitempty"`
	SAnte    string `json:"sante,omitempty"`
	SAntHAGL string `json:"santh_agl,omitempty"` // metres above ground
	SAntHASL string `json:"santh_asl,omitempty"` // metres above sea level
	// Operators lists extra operators who do not appear as the operator of
	// any QSO — typically someone who operated under another person's login.
	// They are merged with the operators found in the log.
	Operators string `json:"operators,omitempty"`
	// ExchField names the QSO field written as the received exchange:
	// "" for none, "dok", or the name of one of the contest's custom fields.
	ExchField string `json:"exch_field,omitempty"`
	Remarks   string `json:"remarks,omitempty"`
}

// REG1TEST leaves the section vocabulary to the contest rules; SINGLE and
// MULTI are what the IARU R1 VHF contests and the national VHF/UHF contests
// that adopted the format expect for single- and multi-operator entries.
const (
	ediSectionSingle = "SINGLE"
	ediSectionMulti  = "MULTI"
)

// ediMaxLine is REG1TEST's line-length limit for lines whose length the
// format does not otherwise fix (a leftover of packet-radio submission).
const ediMaxLine = 75

var (
	ediUnsignedRe = regexp.MustCompile(`^[0-9]{1,6}$`)
	ediSignedRe   = regexp.MustCompile(`^-?[0-9]{1,6}$`)
)

// normalizeEDIHeader validates the edi_header JSON a client sent and returns
// its canonical stored form: trimmed, callsigns upper-cased, operators
// de-duplicated. A header with nothing filled in is stored as "".
func normalizeEDIHeader(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var h EDIHeader
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		return "", errors.New("invalid edi_header")
	}
	for _, p := range []*string{&h.PAdr1, &h.PAdr2, &h.PClub, &h.RName, &h.RCall, &h.RAdr1, &h.RAdr2,
		&h.RPoCo, &h.RCity, &h.RCoun, &h.RPhon, &h.RHBBS, &h.STXEq, &h.SPowe, &h.SRXEq, &h.SAnte,
		&h.SAntHAGL, &h.SAntHASL, &h.PExch, &h.ExchField} {
		*p = ediSingleLine(*p, 120)
	}
	h.PExch = strings.ToUpper(h.PExch)
	if utf8.RuneCountInString(h.PExch) > 6 {
		return "", errors.New("EDI exchange (PExch) must be at most 6 characters")
	}
	h.PClub = strings.ToUpper(h.PClub)
	h.RCall = strings.ToUpper(h.RCall)
	if h.RCall != "" && !ValidCallsign(h.RCall) {
		return "", errors.New("invalid EDI responsible operator callsign")
	}
	if h.SPowe != "" && !ediUnsignedRe.MatchString(h.SPowe) {
		return "", errors.New("EDI transmitter power must be a whole number of watts")
	}
	if h.SAntHAGL != "" && !ediUnsignedRe.MatchString(h.SAntHAGL) {
		return "", errors.New("EDI antenna height above ground must be a whole number of metres")
	}
	if h.SAntHASL != "" && !ediSignedRe.MatchString(h.SAntHASL) {
		return "", errors.New("EDI antenna height above sea level must be a whole number of metres")
	}
	ops, bad := parseOperatorList(h.Operators)
	if bad != "" {
		return "", fmt.Errorf("invalid EDI operator callsign: %s", bad)
	}
	h.Operators = strings.Join(ops, ", ")
	h.Remarks = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(h.Remarks, "\r\n", "\n"), "\r", "\n"))
	if utf8.RuneCountInString(h.Remarks) > 4000 {
		h.Remarks = string([]rune(h.Remarks)[:4000])
	}
	if h == (EDIHeader{}) {
		return "", nil
	}
	b, err := json.Marshal(h)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// parseEDIHeader decodes a stored edi_header. Malformed or empty input yields
// the zero header, so an export never fails over it.
func parseEDIHeader(raw string) EDIHeader {
	var h EDIHeader
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &h)
	}
	return h
}

// ediSingleLine trims s, folds line breaks and tabs into spaces and caps it
// at max runes — header values are one line each.
func ediSingleLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

// parseOperatorList splits a free-form operator list (commas, semicolons or
// whitespace between calls) into upper-cased, de-duplicated callsigns. The
// second return value is the first entry that is not a valid callsign.
func parseOperatorList(s string) ([]string, string) {
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	out := []string{}
	seen := map[string]bool{}
	for _, p := range parts {
		c := strings.ToUpper(p)
		if !ValidCallsign(c) {
			return nil, p
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out, ""
}

// ediOperators returns every operator of the contest, in order of first
// appearance: the operator recorded on each QSO, followed by the extra
// operators entered in the EDI settings.
func ediOperators(qsos []store.QSO, extra string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(c string) {
		c = strings.ToUpper(strings.TrimSpace(c))
		if c == "" || seen[c] {
			return
		}
		seen[c] = true
		out = append(out, c)
	}
	for _, q := range qsos {
		add(q.Operator)
	}
	extras, _ := parseOperatorList(extra)
	for _, c := range extras {
		add(c)
	}
	return out
}

// ediSection is the PSect value: a station worked by one operator (or with
// no operator on record) is a single-operator entry, anything more is
// multi-operator.
func ediSection(ops []string) string {
	if len(ops) > 1 {
		return ediSectionMulti
	}
	return ediSectionSingle
}

// ediResponsible picks RCall: the configured responsible operator, else the
// only (or first) operator in the log, else the station callsign.
func ediResponsible(h EDIHeader, ops []string, stationCall string) string {
	if h.RCall != "" {
		return h.RCall
	}
	if len(ops) > 0 {
		return ops[0]
	}
	return strings.ToUpper(stationCall)
}

// ediOperatorLines distributes the operators other than the responsible one
// over MOpe1 and MOpe2 (REG1TEST: "Responsible operator is not needed in this
// argument"). MOpe1 is filled up to the 75-character line limit and the rest
// goes to MOpe2. Should the team be too large for two lines, MOpe2 runs long
// rather than dropping anyone — a missing operator is worse for the entry
// than an over-long line.
func ediOperatorLines(ops []string, responsible string) (string, string) {
	others := make([]string, 0, len(ops))
	for _, o := range ops {
		if o != responsible {
			others = append(others, o)
		}
	}
	room := ediMaxLine - len("MOpe1=")
	n, i := 0, 0
	for ; i < len(others); i++ {
		add := len(others[i])
		if i > 0 {
			add++ // separator
		}
		if n+add > room {
			break
		}
		n += add
	}
	return strings.Join(others[:i], ";"), strings.Join(others[i:], ";")
}

// ediBandLabels maps Noctalum's band names to the PBand spelling REG1TEST
// prescribes.
var ediBandLabels = map[string]string{
	"6m":     "50 MHz",
	"4m":     "70 MHz",
	"2m":     "144 MHz",
	"70cm":   "432 MHz",
	"23cm":   "1,3 GHz",
	"13cm":   "2,3 GHz",
	"9cm":    "3,4 GHz",
	"6cm":    "5,7 GHz",
	"3cm":    "10 GHz",
	"1.25cm": "24 GHz",
}

func ediBandLabel(band string) string {
	if l, ok := ediBandLabels[strings.ToLower(strings.TrimSpace(band))]; ok {
		return l
	}
	return band
}

// ediLogBand picks the band for PBand: the one carrying the most QSOs (ties
// go to the band worked first). An empty log falls back to the contest's
// band when it has exactly one.
func ediLogBand(qsos []store.QSO, contestBands []string) string {
	counts := map[string]int{}
	best := ""
	for _, q := range qsos {
		if q.Band == "" {
			continue
		}
		counts[q.Band]++
		if best == "" || counts[q.Band] > counts[best] {
			best = q.Band
		}
	}
	if best == "" && len(contestBands) == 1 {
		best = contestBands[0]
	}
	return ediBandLabel(best)
}

// ediDates returns TDate's first and last day: the contest's configured
// dates when set, else the span of the log, else today.
func ediDates(start, end *time.Time, qsos []store.QSO, now time.Time) (time.Time, time.Time) {
	if start != nil {
		if end != nil {
			return *start, *end
		}
		return *start, *start
	}
	if len(qsos) == 0 {
		return now, now
	}
	first, last := qsos[0].Time, qsos[0].Time
	for _, q := range qsos[1:] {
		if q.Time.Before(first) {
			first = q.Time
		}
		if q.Time.After(last) {
			last = q.Time
		}
	}
	return first.UTC(), last.UTC()
}

// ediTransliterations covers the non-ASCII letters European operators are
// likely to type into names and addresses. REG1TEST files are 7-bit ASCII.
var ediTransliterations = map[rune]string{
	'ä': "ae", 'ö': "oe", 'ü': "ue", 'Ä': "Ae", 'Ö': "Oe", 'Ü': "Ue", 'ß': "ss",
	'æ': "ae", 'Æ': "Ae", 'ø': "oe", 'Ø': "Oe", 'å': "aa", 'Å': "Aa", 'œ': "oe", 'Œ': "Oe",
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ą': "a", 'ă': "a", 'ā': "a",
	'À': "A", 'Á': "A", 'Â': "A", 'Ã': "A", 'Ą': "A", 'Ă': "A", 'Ā': "A",
	'ç': "c", 'ć': "c", 'č': "c", 'Ç': "C", 'Ć': "C", 'Č': "C",
	'ď': "d", 'đ': "d", 'Ď': "D", 'Đ': "D",
	'è': "e", 'é': "e", 'ê': "e", 'ë': "e", 'ę': "e", 'ě': "e", 'ē': "e",
	'È': "E", 'É': "E", 'Ê': "E", 'Ë': "E", 'Ę': "E", 'Ě': "E", 'Ē': "E",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i", 'Ì': "I", 'Í': "I", 'Î': "I", 'Ï': "I",
	'ł': "l", 'ľ': "l", 'ĺ': "l", 'Ł': "L", 'Ľ': "L", 'Ĺ': "L",
	'ñ': "n", 'ń': "n", 'ň': "n", 'Ñ': "N", 'Ń': "N", 'Ň': "N",
	'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ő': "o", 'Ò': "O", 'Ó': "O", 'Ô': "O", 'Õ': "O", 'Ő': "O",
	'ŕ': "r", 'ř': "r", 'Ŕ': "R", 'Ř': "R",
	'ś': "s", 'š': "s", 'ş': "s", 'ș': "s", 'Ś': "S", 'Š': "S", 'Ş': "S", 'Ș': "S",
	'ť': "t", 'ţ': "t", 'ț': "t", 'Ť': "T", 'Ţ': "T", 'Ț': "T",
	'ù': "u", 'ú': "u", 'û': "u", 'ů': "u", 'ű': "u", 'Ù': "U", 'Ú': "U", 'Û': "U", 'Ů': "U", 'Ű': "U",
	'ý': "y", 'ÿ': "y", 'Ý': "Y",
	'ź': "z", 'ż': "z", 'ž': "z", 'Ź': "Z", 'Ż': "Z", 'Ž': "Z",
}

// ediASCII reduces s to the printable 7-bit ASCII REG1TEST allows,
// transliterating common accented letters and replacing anything else with
// '?'.
func ediASCII(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 32 && r < 127:
			b.WriteRune(r)
		case r == '\t':
			b.WriteByte(' ')
		default:
			if t, ok := ediTransliterations[r]; ok {
				b.WriteString(t)
			} else {
				b.WriteByte('?')
			}
		}
	}
	return b.String()
}

// ediField makes a value safe for a semicolon-separated QSO record.
func ediField(s string, max int) string {
	s = strings.ReplaceAll(ediASCII(strings.TrimSpace(s)), ";", ",")
	if len(s) > max {
		s = s[:max]
	}
	return s
}

// ediExchange returns the received exchange for a QSO, read from the field
// the EDI settings name.
func ediExchange(q store.QSO, field string) string {
	switch field {
	case "":
		return ""
	case "dok":
		return strings.ToUpper(q.DOK)
	default:
		return strings.ToUpper(parseExtras(q.Extras)[field])
	}
}

// EDIExportOptions carries everything ExportEDI needs besides the QSOs.
type EDIExportOptions struct {
	ContestName string
	StationCall string
	QTH         string
	// Bands are the contest's configured bands; PBand falls back to them
	// when the log is empty.
	Bands []string
	// StartDate and EndDate are the contest's configured dates (optional).
	StartDate, EndDate *time.Time
	// HeaderJSON is the contest's stored edi_header.
	HeaderJSON string
	// Now stands in for the current time in TDate when neither dates nor
	// QSOs are available; zero means time.Now().
	Now time.Time
}

// ExportEDI writes the QSO list to w as an IARU Region 1 REG1TEST (EDI)
// VHF/UHF contest log, with CR LF line endings and 7-bit ASCII as the format
// requires.
//
// The section follows the operators: one operator (from the QSOs' operator
// field plus any extra operators in the EDI settings) makes a SINGLE entry,
// more than one a MULTI entry, and everyone but the responsible operator is
// listed in MOpe1/MOpe2.
func ExportEDI(w io.Writer, qsos []store.QSO, opts EDIExportOptions) error {
	h := parseEDIHeader(opts.HeaderJSON)
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	start, end := ediDates(opts.StartDate, opts.EndDate, qsos, now)
	ops := ediOperators(qsos, h.Operators)
	responsible := ediResponsible(h, ops, opts.StationCall)
	mope1, mope2 := ediOperatorLines(ops, responsible)
	antH := ""
	if h.SAntHAGL != "" || h.SAntHASL != "" {
		antH = h.SAntHAGL + ";" + h.SAntHASL
	}

	bw := bufio.NewWriter(w)
	line := func(s string) {
		bw.WriteString(ediASCII(s))
		bw.WriteString("\r\n")
	}
	header := []string{
		"[REG1TEST;1]",
		"TName=" + opts.ContestName,
		"TDate=" + start.Format("20060102") + ";" + end.Format("20060102"),
		"PCall=" + strings.ToUpper(opts.StationCall),
		"PWWLo=" + strings.ToUpper(opts.QTH),
		"PExch=" + h.PExch,
		"PAdr1=" + h.PAdr1,
		"PAdr2=" + h.PAdr2,
		"PSect=" + ediSection(ops),
		"PBand=" + ediLogBand(qsos, opts.Bands),
		"PClub=" + h.PClub,
		"RName=" + h.RName,
		"RCall=" + responsible,
		"RAdr1=" + h.RAdr1,
		"RAdr2=" + h.RAdr2,
		"RPoCo=" + h.RPoCo,
		"RCity=" + h.RCity,
		"RCoun=" + h.RCoun,
		"RPhon=" + h.RPhon,
		"RHBBS=" + h.RHBBS,
		"MOpe1=" + mope1,
		"MOpe2=" + mope2,
		"STXEq=" + h.STXEq,
		"SPowe=" + h.SPowe,
		"SRXEq=" + h.SRXEq,
		"SAnte=" + h.SAnte,
		"SAntH=" + antH,
		"CQSOs=" + strconv.Itoa(len(qsos)) + ";1",
		"CQSOP=0",
		"CWWLs=0;0;0",
		"CWWLB=0",
		"CExcs=0;0;0",
		"CExcB=0",
		"CDXCs=0;0;0",
		"CDXCB=0",
		"CToSc=0",
		"CODXC=;;0",
		"[Remarks]",
	}
	for _, l := range header {
		line(l)
	}
	if h.Remarks != "" {
		for _, l := range strings.Split(h.Remarks, "\n") {
			line(l)
		}
	}
	line("[QSORecords;" + strconv.Itoa(len(qsos)) + "]")
	// Date;Time;Call;Mode code;Sent-RST;Sent QSO number;Received-RST;
	// Received QSO number;Received exchange;Received-WWL;QSO-Points;
	// New-Exchange;New-WWL;New-DXCC;Duplicate-QSO
	for _, q := range qsos {
		t := q.Time.UTC()
		nrSent := ""
		if q.NrSent > 0 {
			nrSent = fmt.Sprintf("%03d", q.NrSent)
		}
		nrRcvd := ""
		if q.NrReceived > 0 {
			nrRcvd = fmt.Sprintf("%03d", q.NrReceived)
		}
		line(strings.Join([]string{
			t.Format("060102"),
			t.Format("1504"),
			ediField(strings.ToUpper(q.Callsign), 14),
			ediMode(q.Mode),
			ediField(q.RSTSent, 3),
			nrSent,
			ediField(q.RSTReceived, 3),
			nrRcvd,
			ediField(ediExchange(q, h.ExchField), 6),
			ediField(strings.ToUpper(q.Locator), 6),
			"0",
			"",
			"",
			"",
			"",
		}, ";"))
	}
	return bw.Flush()
}
