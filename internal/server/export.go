package server

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/adif"
	"github.com/noctalum/noctalum/internal/store"
)

// adifFieldName normalises a custom-field name into a safe ADIF
// application-defined tag: uppercase, with anything outside A–Z/0–9/underscore
// replaced by underscore. The result is suffixed onto APP_<PROGRAMID>_.
func adifFieldName(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r - 32)
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		out = "FIELD"
	}
	return out
}

// ExportADIF writes the QSO list to w in ADIF 3.x format. customFieldsJSON, when
// non-empty, lists the contest's per-QSO custom fields; their values are
// emitted as application-defined fields (APP_<PROGRAMID>_<NAME>) so the data
// round-trips through ADIF-aware tools without colliding with standard tags.
// myGridsquare, when non-empty, is emitted as MY_GRIDSQUARE on every record —
// award trackers rely on it to compute worked-grids/DXCC-from-here credits.
func ExportADIF(w io.Writer, qsos []store.QSO, programID, programVersion, customFieldsJSON, myGridsquare string) error {
	header := fmt.Sprintf("ADIF export from %s %s\n", programID, programVersion)
	if _, err := io.WriteString(w, header); err != nil {
		return err
	}
	// Declare the spec release the field catalogue was generated from. It has
	// to be at least 3.1.5, the first version that defines IntlString /
	// IntlMultilineString lengths as *bytes* (UTF-8) rather than characters —
	// which is what `len(value)` gives us for the _INTL fields below. It also
	// has to be recent enough to cover every tag we may emit: custom fields
	// now reach the whole catalogue, including fields introduced in 3.1.6 and
	// 3.1.7 (BAND_RX, ALTITUDE, MORSE_KEY_*, the DCL_* set, …), and declaring
	// an older version while using them is exactly what strict validators
	// reject. Tracking adif.SpecVersion keeps the two in step through the next
	// spec bump on its own.
	writeField(w, "ADIF_VER", adif.SpecVersion)
	writeField(w, "PROGRAMID", programID)
	writeField(w, "PROGRAMVERSION", programVersion)
	writeField(w, "CREATED_TIMESTAMP", time.Now().UTC().Format("20060102 150405"))
	if _, err := io.WriteString(w, "<EOH>\n\n"); err != nil {
		return err
	}
	customFields := parseCustomFieldDefs(customFieldsJSON)
	appPrefix := "APP_" + strings.ToUpper(adifFieldName(programID)) + "_"
	for _, q := range qsos {
		writeField(w, "CALL", q.Callsign)
		if q.Name != "" {
			// ADIF `NAME` is defined as ASCII-only String. Names with
			// umlauts or accents (e.g. "Jörg", "José") violate that,
			// but ADIF 3.1.x introduced `NAME_INTL` (IntlString / UTF-8)
			// for exactly this case. Prefer the _INTL variant when any
			// byte falls outside 7-bit ASCII so importers know to
			// UTF-8-decode.
			if hasNonASCII(q.Name) {
				writeField(w, "NAME_INTL", q.Name)
			} else {
				writeField(w, "NAME", q.Name)
			}
		}
		writeField(w, "QSO_DATE", q.Time.UTC().Format("20060102"))
		writeField(w, "TIME_ON", q.Time.UTC().Format("150405"))
		writeField(w, "BAND", strings.ToLower(q.Band))
		if q.FreqHz > 0 {
			mhz := float64(q.FreqHz) / 1_000_000.0
			writeField(w, "FREQ", strconv.FormatFloat(mhz, 'f', 6, 64))
		}
		mode, submode := adifModeSubmode(q.Mode)
		writeField(w, "MODE", mode)
		if submode != "" {
			writeField(w, "SUBMODE", submode)
		}
		writeField(w, "RST_SENT", q.RSTSent)
		writeField(w, "RST_RCVD", q.RSTReceived)
		// Contest exchange numbers: ADIF integer form is STX (sent) / SRX
		// (received). Omit when unset so 0 doesn't leak into non-contest
		// QSOs that were imported without a sequence.
		if q.NrSent > 0 {
			writeField(w, "STX", strconv.Itoa(q.NrSent))
		}
		if q.NrReceived > 0 {
			writeField(w, "SRX", strconv.Itoa(q.NrReceived))
		}
		if q.DOK != "" {
			writeField(w, "DARC_DOK", strings.ToUpper(q.DOK))
		}
		if q.Locator != "" {
			// Uppercase to match MY_GRIDSQUARE and the LotW/eQSL/DXCC
			// convention. Mixed-case locators are technically legal per
			// spec but some award trackers normalise on upload — emit
			// them upper already so re-imports round-trip cleanly.
			writeField(w, "GRIDSQUARE", strings.ToUpper(q.Locator))
		}
		if q.ITUZone != "" {
			writeField(w, "ITUZ", q.ITUZone)
		}
		if q.CQZone != "" {
			writeField(w, "CQZ", q.CQZone)
		}
		if q.Lighthouse != "" {
			// ADIF has no dedicated lighthouse field — the idiomatic mapping
			// is SIG=<program> + SIG_INFO=<reference>. Bare <ARLHS> tags were
			// invented by early loggers and get rejected by strict validators.
			writeField(w, "SIG", "ARLHS")
			writeField(w, "SIG_INFO", q.Lighthouse)
		}
		writeField(w, "OPERATOR", q.Operator)
		writeField(w, "STATION_CALLSIGN", q.StationCall)
		// MY_GRIDSQUARE is the exporting station's own Maidenhead
		// locator. Award trackers (LotW, eQSL, VUCC) rely on it to
		// credit worked-grids/DXCC-from-here — omitting it forces
		// operators to hand-edit every export before submission.
		if myGridsquare != "" {
			writeField(w, "MY_GRIDSQUARE", strings.ToUpper(myGridsquare))
		}
		notes := q.Notes
		if q.ContestName != "" {
			if id, ok := adifContestID(q.ContestName); ok {
				writeField(w, "CONTEST_ID", id)
			} else {
				// Contest name isn't in the ADIF enum (e.g. a local
				// DARC OV activity like "WSA 2026"). Emitting it as
				// CONTEST_ID gets the record rejected by strict
				// importers, so prepend "Contest: <name>" to NOTES
				// where free text is legal.
				prefix := "Contest: " + q.ContestName
				if notes == "" {
					notes = prefix
				} else {
					// MultilineString / IntlMultilineString line breaks
					// are CR/LF per ADIF 3.1.5 §Data Types — bare LF is
					// technically non-conforming.
					notes = prefix + "\r\n" + notes
				}
			}
		}
		if notes != "" {
			// ADIF distinguishes COMMENT (QSO-relevant remarks) from NOTES
			// (general operator notes). Our field is a free-form text box,
			// so NOTES is the more accurate mapping and matches what
			// LotW/eQSL importers expect. UTF-8 payloads (umlauts,
			// non-Latin scripts) go into NOTES_INTL — the plain NOTES
			// field is ASCII-only per spec.
			notes = normaliseCRLF(notes)
			if hasNonASCII(notes) {
				writeField(w, "NOTES_INTL", notes)
			} else {
				writeField(w, "NOTES", notes)
			}
		}
		if len(customFields) > 0 {
			// ADIF forbids the same field appearing twice in one record.
			// Everything above is emitted from a dedicated QSO column, so
			// seed the guard with those tags and let it also catch two
			// custom fields that normalise onto the same name.
			emitted := map[string]bool{}
			for _, tag := range builtinADIFTags {
				emitted[tag] = true
			}
			extras := parseExtras(q.Extras)
			for _, cf := range customFields {
				if cf.Name == "" {
					continue
				}
				val := extras[cf.Name]
				if val == "" {
					continue
				}
				// If the operator named their custom field after a standard
				// ADIF tag (e.g. "STATE", "POTA_REF"), emit it under that
				// standard tag so award trackers can consume it directly.
				// Anything the ADIF catalogue doesn't recognise — plus the
				// tags we already write ourselves and the spec's import-only
				// fields — falls back to APP_<PROGRAMID>_<NAME>, the
				// ADIF-defined escape hatch for application-specific data.
				tag := adifFieldName(cf.Name)
				if f, ok := adif.Exportable(tag); ok {
					// The entry mask hands back what its control produced:
					// "2026-03-22" from a date picker, "14:05" from a time
					// picker. ADIF wants 20260322 / 140500.
					val = adif.Normalize(f, val)
					if val == "" {
						continue
					}
					if f.Type == "MultilineString" || f.Type == "IntlMultilineString" {
						val = normaliseCRLF(val)
					}
					// ADIF String fields are ASCII-only; the spec's _INTL
					// sibling is the UTF-8 home for values that aren't.
					if f.Intl != "" && hasNonASCII(val) {
						tag = f.Intl
					}
				} else {
					tag = appPrefix + tag
				}
				if emitted[tag] {
					continue
				}
				emitted[tag] = true
				writeField(w, tag, val)
			}
		}
		if _, err := io.WriteString(w, "<EOR>\n\n"); err != nil {
			return err
		}
	}
	return nil
}

// hasNonASCII reports whether s contains any byte outside 7-bit ASCII.
// Used to decide between an ADIF String field (ASCII-only per spec) and
// its IntlString "_INTL" sibling (UTF-8 permitted).
func hasNonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 0x7F {
			return true
		}
	}
	return false
}

// normaliseCRLF rewrites all line breaks in s to CR/LF pairs, which is the
// line-separator ADIF 3.1.5 requires inside MultilineString and
// IntlMultilineString fields. Bare LF or CR alone are technically
// non-conforming; some strict validators reject the record.
func normaliseCRLF(s string) string {
	if !strings.ContainsAny(s, "\r\n") {
		return s
	}
	// Collapse existing CR/LF and stray CRs first so we don't double-up.
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}

func writeField(w io.Writer, name, value string) {
	if value == "" {
		return
	}
	fmt.Fprintf(w, "<%s:%d>%s ", name, len(value), value)
}

// adifContestIDs is a case-insensitive index of the ADIF Contest_ID
// enumeration values we recognise. It is intentionally a subset —
// covering the DARC, IARU, CQ, ARRL and RSGB contests our users
// participate in. Anything not in this map falls back to being written
// into the NOTES field so strict ADIF importers (DXKeeper, Log4OM, LotW)
// don't reject the record for CONTEST_ID enum violations.
//
// Keys are stored fully upper-cased with punctuation stripped so that
// contest names typed with different casing / spacing (e.g. "IARU HF",
// "iaru-hf", "IARU-HF") all match a single entry. The value is the
// canonical ADIF enum spelling.
var adifContestIDs = func() map[string]string {
	list := []string{
		// DARC contests
		"DARC-FT4",
		"DARC-WAEDC-CW",
		"DARC-WAEDC-RTTY",
		"DARC-WAEDC-SSB",
		"DARC-WAG",
		"DL-DX-RTTY",
		// IARU / general HF
		"IARU-HF",
		"IARU-FIELD-DAY",
		"EU-HF",
		"EU-PSK-DX",
		"EU-SPRINT",
		"EUCW160M",
		"HELVETIA",
		// CQ contests
		"CQ-160-CW",
		"CQ-160-SSB",
		"CQ-M",
		"CQ-WPX-CW",
		"CQ-WPX-RTTY",
		"CQ-WPX-SSB",
		"CQ-WW-CW",
		"CQ-WW-RTTY",
		"CQ-WW-SSB",
		"CQ-WW-VHF",
		// ARRL
		"ARRL-10",
		"ARRL-160",
		"ARRL-DX-CW",
		"ARRL-DX-SSB",
		"ARRL-FIELD-DAY",
		"ARRL-RTTY",
		"ARRL-SS-CW",
		"ARRL-SS-SSB",
		"ARRL-VHF-JAN",
		"ARRL-VHF-JUN",
		"ARRL-VHF-SEP",
		// RSGB
		"RSGB-160",
		"RSGB-21/28-CW",
		"RSGB-21/28-SSB",
		"RSGB-IOTA",
		// REF (France)
		"REF-160M",
		"REF-CW",
		"REF-SSB",
		// Scandinavian Activity Contest
		"SAC-CW",
		"SAC-SSB",
	}
	m := make(map[string]string, len(list))
	for _, id := range list {
		m[normaliseContestKey(id)] = id
	}
	return m
}()

// normaliseContestKey collapses a contest identifier to a lookup key:
// upper-case, with hyphens, spaces, underscores and slashes stripped.
// This lets "IARU HF", "iaru-hf" and "IARU_HF" all collide on the same
// canonical entry.
func normaliseContestKey(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case ' ', '-', '_', '/':
			continue
		default:
			if r >= 'a' && r <= 'z' {
				b.WriteRune(r - 32)
			} else {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

// adifContestID looks up a contest name against the ADIF Contest_ID
// enumeration. Returns the canonical enum value and true on hit; empty
// string and false if the caller should fall back to putting the
// contest name into NOTES.
func adifContestID(name string) (string, bool) {
	id, ok := adifContestIDs[normaliseContestKey(name)]
	return id, ok
}

// builtinADIFTags lists the tags ExportADIF writes from dedicated QSO columns
// above. It seeds the per-record duplicate guard: ADIF forbids a field name
// appearing in more than one Data Specifier within a record, so a custom field
// that lands on one of these names must be dropped rather than emitted a
// second time. The catalogue marks the same tags "builtin", which is what
// keeps them out of the contest-settings field picker in the first place —
// this list is the belt to that pair of braces, covering contests whose
// custom_fields were saved before the picker existed.
var builtinADIFTags = []string{
	"CALL", "NAME", "NAME_INTL", "QSO_DATE", "TIME_ON", "BAND", "FREQ",
	"MODE", "SUBMODE", "RST_SENT", "RST_RCVD", "STX", "SRX", "DARC_DOK",
	"GRIDSQUARE", "ITUZ", "CQZ", "SIG", "SIG_INFO", "OPERATOR",
	"STATION_CALLSIGN", "MY_GRIDSQUARE", "CONTEST_ID", "NOTES", "NOTES_INTL",
}

// adifModeSubmode maps our internal mode string to the (MODE, SUBMODE) pair
// required by ADIF 3.1.5. In ADIF, PSK31/PSK63 are SUBMODEs of PSK, FT8/FT4
// are SUBMODEs of MFSK, and JT65A/JT9A are SUBMODEs of the JT65/JT9 modes.
// When we emit MODE=FT8 directly, strict importers (DXKeeper, LotW) reject
// the record because FT8 is not a legal MODE enum value.
//
// Anything not in this table falls through as MODE=<uppercased input> with
// no SUBMODE — the safe default for CW/SSB/AM/FM/RTTY etc. which are legal
// top-level modes.
func adifModeSubmode(m string) (mode, submode string) {
	switch strings.ToUpper(m) {
	case "FT8":
		return "MFSK", "FT8"
	case "FT4":
		return "MFSK", "FT4"
	case "PSK31":
		return "PSK", "PSK31"
	case "PSK63":
		return "PSK", "PSK63"
	case "PSK125":
		return "PSK", "PSK125"
	case "JT65A":
		return "JT65", "JT65A"
	case "JT65B":
		return "JT65", "JT65B"
	case "JT65C":
		return "JT65", "JT65C"
	case "JT9A":
		return "JT9", "JT9A"
	case "USB":
		return "SSB", "USB"
	case "LSB":
		return "SSB", "LSB"
	default:
		return strings.ToUpper(m), ""
	}
}

// ExportCSV writes the QSO list to w as CSV. customFieldsJSON, when non-empty,
// lists the contest's per-QSO custom fields; one extra column per custom field
// is appended after the standard columns so spreadsheet tools see them as
// first-class data.
//
// A UTF-8 BOM is emitted up front so Excel detects the encoding instead of
// falling back to the local code page (which mangles umlauts and other
// non-ASCII characters).
func ExportCSV(w io.Writer, qsos []store.QSO, customFieldsJSON string) error {
	if _, err := w.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	defer cw.Flush()
	customFields := parseCustomFieldDefs(customFieldsJSON)
	header := []string{
		"id", "time_utc", "callsign", "name", "band", "freq_hz", "mode",
		"rst_sent", "rst_received", "nr_sent", "nr_received",
		"dok", "locator", "itu_zone", "cq_zone",
		"lighthouse", "operator", "station_call", "contest_name", "notes",
	}
	for _, cf := range customFields {
		if cf.Name == "" {
			continue
		}
		// Use the original (case-preserved) field name as the column header so
		// operators recognise it; the row values are looked up by the same key.
		header = append(header, cf.Name)
	}
	if err := cw.Write(header); err != nil {
		return err
	}
	for _, q := range qsos {
		nrSent := ""
		if q.NrSent > 0 {
			nrSent = strconv.Itoa(q.NrSent)
		}
		nrRcvd := ""
		if q.NrReceived > 0 {
			nrRcvd = strconv.Itoa(q.NrReceived)
		}
		row := []string{
			strconv.FormatInt(q.ID, 10),
			q.Time.UTC().Format(time.RFC3339),
			q.Callsign, q.Name, q.Band, strconv.FormatInt(q.FreqHz, 10), q.Mode,
			q.RSTSent, q.RSTReceived, nrSent, nrRcvd,
			strings.ToUpper(q.DOK), q.Locator, q.ITUZone, q.CQZone,
			q.Lighthouse, q.Operator, q.StationCall, q.ContestName, q.Notes,
		}
		if len(customFields) > 0 {
			extras := parseExtras(q.Extras)
			for _, cf := range customFields {
				if cf.Name == "" {
					continue
				}
				row = append(row, extras[cf.Name])
			}
		}
		if err := cw.Write(row); err != nil {
			return err
		}
	}
	return nil
}

// ExportCabrillo writes the QSO list to w as a Cabrillo v3 contest log.
// Exchanges are written as "<rst_sent> <station_call> | <rst_received> <callsign>"
// in a generic form; users should post-process for specific contests.
func ExportCabrillo(w io.Writer, qsos []store.QSO, contestName, stationCall string) error {
	header := []string{
		"START-OF-LOG: 3.0",
		"CREATED-BY: Noctalum",
		fmt.Sprintf("CONTEST: %s", strings.ToUpper(contestName)),
		fmt.Sprintf("CALLSIGN: %s", strings.ToUpper(stationCall)),
		"CATEGORY-OPERATOR: MULTI-OP",
		"CATEGORY-STATION: FIXED",
		"CATEGORY-TRANSMITTER: ONE",
	}
	for _, h := range header {
		if _, err := fmt.Fprintln(w, h); err != nil {
			return err
		}
	}
	for _, q := range qsos {
		freqKHz := q.FreqHz / 1000
		mode := cabrilloMode(q.Mode)
		t := q.Time.UTC()
		if _, err := fmt.Fprintf(w, "QSO: %5d %2s %s %04s %-13s %-3s %-6s %-13s %-3s %-6s\n",
			freqKHz, mode, t.Format("2006-01-02"), t.Format("1504"),
			strings.ToUpper(stationCall), q.RSTSent, q.ITUZone,
			strings.ToUpper(q.Callsign), q.RSTReceived, q.CQZone,
		); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(w, "END-OF-LOG:")
	return err
}

func cabrilloMode(mode string) string {
	switch strings.ToUpper(mode) {
	case "CW":
		return "CW"
	case "RTTY", "PSK31", "PSK63", "FT8", "FT4", "JT65", "JT9", "MFSK", "OLIVIA", "DIGI":
		return "RY"
	default:
		return "PH"
	}
}

// ediMode maps an internal mode to the IARU R1 EDI mode digit:
// 1=SSB, 2=CW, 3=SSB+CW, 4=RTTY, 5=AM, 6=FM, 7=FAX, 8=SSTV, 9=ATV.
// Digital modes (FT8 etc.) map to 4 (RTTY/digi).
func ediMode(mode string) string {
	switch strings.ToUpper(mode) {
	case "SSB", "USB", "LSB":
		return "1"
	case "CW":
		return "2"
	case "RTTY", "PSK31", "PSK63", "FT8", "FT4", "JT65", "JT9", "MFSK", "OLIVIA", "DIGI":
		return "4"
	case "AM":
		return "5"
	case "FM":
		return "6"
	default:
		return "1"
	}
}

// ExportEDI writes the QSO list to w as an IARU Region 1 EDI VHF/UHF contest
// log.  This is a generic export — operators usually need to fine-tune the
// header (PCall, PSect, PBand, etc.) before submission.
func ExportEDI(w io.Writer, qsos []store.QSO, contestName, stationCall, qth string) error {
	now := time.Now().UTC()
	contestStart := now
	contestEnd := now
	if len(qsos) > 0 {
		contestStart = qsos[0].Time
		contestEnd = qsos[len(qsos)-1].Time
	}
	band := ""
	if len(qsos) > 0 {
		band = qsos[0].Band
	}
	header := []string{
		"[REG1TEST;1]",
		"TName=" + contestName,
		"TDate=" + contestStart.Format("20060102") + ";" + contestEnd.Format("20060102"),
		"PCall=" + strings.ToUpper(stationCall),
		"PWWLo=" + strings.ToUpper(qth),
		"PSect=SOMB",
		"PBand=" + band,
		"PClub=",
		"RName=",
		"RCall=",
		"RAdr1=",
		"RAdr2=",
		"RPoCo=",
		"RCity=",
		"RCoun=",
		"RPhon=",
		"RHBBS=",
		"MOpe1=",
		"MOpe2=",
		"STXEq=",
		"SPowe=",
		"SRXEq=",
		"SAnte=",
		"SAntH=",
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
		"",
		"[QSORecords;" + strconv.Itoa(len(qsos)) + "]",
	}
	for _, h := range header {
		if _, err := fmt.Fprintln(w, h); err != nil {
			return err
		}
	}
	// QSO record format (semi-colon separated):
	// YYMMDD;HHMM;Call;Mode;RSTSent;NrSent;RSTRecv;NrRecv;Exch;WWL;Pts;ITUZ;DXCC;NewWWL;Multi
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
		fields := []string{
			t.Format("060102"),
			t.Format("1504"),
			strings.ToUpper(q.Callsign),
			ediMode(q.Mode),
			q.RSTSent,
			nrSent,
			q.RSTReceived,
			nrRcvd,
			"",
			strings.ToUpper(q.Locator),
			"0",
			"",
			"",
			"",
			"",
		}
		if _, err := fmt.Fprintln(w, strings.Join(fields, ";")); err != nil {
			return err
		}
	}
	return nil
}
