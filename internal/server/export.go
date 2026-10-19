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

// ADIFExportOptions carries everything ExportADIF needs beyond the QSOs
// themselves. It is a struct rather than a parameter list because every member
// is a string: positional arguments of the same type are the kind of thing
// that silently swaps places during a refactor.
type ADIFExportOptions struct {
	// ProgramID / ProgramVersion go into the file header and give the
	// APP_<PROGRAMID>_ prefix its name.
	ProgramID      string
	ProgramVersion string
	// CustomFieldsJSON lists the contest's per-QSO custom fields. Values
	// land on their own ADIF tag when the name is one the spec defines, and
	// on APP_<PROGRAMID>_<NAME> otherwise.
	CustomFieldsJSON string
	// MyGridsquare is the contest QTH — the logging station's own Maidenhead
	// locator, exported as MY_GRIDSQUARE unless the mapping says otherwise.
	MyGridsquare string
	// MappingJSON holds the contest's ADIF mapping overrides: which ADIF tag
	// each Noctalum data field lands on, for the fields whose mapping the
	// operator changed. Empty means "everything at its default".
	MappingJSON string
	// NrPadded mirrors the contest's "pad serial numbers to 3 digits"
	// setting, so STX/SRX carry the same 001/042 form the operator sees in
	// the log and sends on the air.
	NrPadded bool
}

// formatSerial renders a contest serial number the way the contest's
// "pad serial numbers to 3 digits" setting says it should look: 001, 042, 117
// when padding is on, 1, 42, 117 when it is off. Serials past 999 keep their
// natural width either way.
//
// A serial of 0 means "this QSO has no sequence number" — non-contest QSOs and
// ADIF imports that arrived without one — and always renders empty so a bare 0
// never leaks into an export.
func formatSerial(n int, padded bool) string {
	if n <= 0 {
		return ""
	}
	if padded {
		return fmt.Sprintf("%03d", n)
	}
	return strconv.Itoa(n)
}

// ExportADIF writes the QSO list to w in ADIF 3.x format.
//
// Which ADIF tag each Noctalum data field lands on is decided by
// adifSourceFields and the contest's mapping overrides — see
// internal/server/adif_mapping.go. With no overrides the output is exactly
// what Noctalum has always written.
func ExportADIF(w io.Writer, qsos []store.QSO, opts ADIFExportOptions) error {
	header := fmt.Sprintf("ADIF export from %s %s\n", opts.ProgramID, opts.ProgramVersion)
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
	writeField(w, "PROGRAMID", opts.ProgramID)
	writeField(w, "PROGRAMVERSION", opts.ProgramVersion)
	writeField(w, "CREATED_TIMESTAMP", time.Now().UTC().Format("20060102 150405"))
	if _, err := io.WriteString(w, "<EOH>\n\n"); err != nil {
		return err
	}
	customFields := parseCustomFieldDefs(opts.CustomFieldsJSON)
	appPrefix := "APP_" + strings.ToUpper(adifFieldName(opts.ProgramID)) + "_"
	mapping := resolveADIFMapping(opts.MappingJSON)

	for _, q := range qsos {
		// ADIF forbids the same field name appearing in more than one Data
		// Specifier within a record. One guard covers both halves of the
		// record: two source fields re-mapped onto the same tag, and a custom
		// field colliding with whatever a source field landed on.
		emitted := map[string]bool{}
		emit := func(tag, value string) {
			if tag == "" || value == "" || emitted[tag] {
				return
			}
			emitted[tag] = true
			writeField(w, tag, value)
		}

		// The contest name falls back into NOTES when it isn't an ADIF
		// CONTEST_ID enum value, so it has to be resolved before notes are
		// written. Only while contest_name still sits on CONTEST_ID: once the
		// operator points it at a tag of their own, that tag is where the
		// name belongs and hijacking NOTES would be a surprise.
		notesPrefix := ""
		if mapping["contest_name"] == "CONTEST_ID" && q.ContestName != "" {
			if _, ok := adifContestID(q.ContestName); !ok {
				// Emitting an unknown name as CONTEST_ID gets the record
				// rejected by strict importers, so it goes to NOTES where
				// free text is legal (e.g. a local DARC OV activity).
				notesPrefix = "Contest: " + q.ContestName
			}
		}

		for _, src := range adifSourceFields {
			if src.Key == "time" {
				// One value, two tags — not re-mappable, so it is written
				// directly rather than through the mapping.
				emit("QSO_DATE", q.Time.UTC().Format("20060102"))
				emit("TIME_ON", q.Time.UTC().Format("150405"))
				continue
			}
			tag := mapping[src.Key]
			if tag == "" {
				continue // no default, or switched off by the operator
			}
			value := adifSourceValue(src.Key, q, opts.MyGridsquare, opts.NrPadded)
			switch src.Key {
			case "contest_name":
				if notesPrefix != "" {
					continue // written into NOTES below instead
				}
				if tag == "CONTEST_ID" {
					value, _ = adifContestID(value)
				}
			case "notes":
				if notesPrefix != "" {
					if value == "" {
						value = notesPrefix
					} else {
						value = notesPrefix + "\r\n" + value
					}
				}
			}
			if value == "" {
				continue
			}
			if ctag, cval := adifCompanion(src.Key, tag, q); ctag != "" {
				emit(ctag, cval)
			}
			emit(adifTagFor(tag, &value), value)
		}

		if len(customFields) > 0 {
			extras := parseExtras(q.Extras)
			for _, cf := range customFields {
				if cf.Name == "" {
					continue
				}
				val := extras[cf.Name]
				if val == "" {
					continue
				}
				// The tag comes from the operator's mapping when they set one,
				// and otherwise from the field's own name: a field named after
				// a standard ADIF tag (e.g. "STATE", "POTA_REF") lands on that
				// tag so award trackers can consume it directly, and anything
				// else falls back to APP_<PROGRAMID>_<NAME>, the ADIF-defined
				// escape hatch for application-specific data.
				tag, on := adifCustomFieldTag(cf.Name, mapping, appPrefix)
				if !on {
					continue // switched off in the mapping editor
				}
				if _, ok := adif.Lookup(tag); ok {
					tag = adifTagFor(tag, &val)
					if val == "" {
						continue
					}
				}
				emit(tag, val)
			}
		}
		if _, err := io.WriteString(w, "<EOR>\n\n"); err != nil {
			return err
		}
	}
	return nil
}

// adifTagFor prepares a value for the tag it is about to be written under and
// returns the tag actually to use. It normalises the value to the wire form
// the field's ADIF data type requires (the entry mask's date and time controls
// hand back "2026-03-22" and "14:05"; ADIF wants 20260322 and 140500), rewrites
// multiline breaks to the CR/LF the spec demands, and switches to the field's
// _INTL sibling when the value carries bytes an ASCII-only String field may not.
//
// value is a pointer because all three of those can rewrite it, and a caller
// that skipped the rewrite would emit a malformed record.
func adifTagFor(tag string, value *string) string {
	f, ok := adif.Lookup(tag)
	if !ok {
		return tag
	}
	*value = adif.Normalize(f, *value)
	if *value == "" {
		return tag
	}
	if f.Type == "MultilineString" || f.Type == "IntlMultilineString" {
		// MultilineString / IntlMultilineString line breaks are CR/LF per
		// the ADIF Data Types section — bare LF is non-conforming and some
		// strict validators reject the record.
		*value = normaliseCRLF(*value)
	}
	// ADIF String fields are ASCII-only. Names and notes with umlauts or
	// accents ("Jörg", "München") belong in the spec's IntlString "_INTL"
	// sibling, which importers know to UTF-8-decode.
	if f.Intl != "" && hasNonASCII(*value) {
		return f.Intl
	}
	return tag
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

// CabrilloExportOptions carries everything ExportCabrillo needs beyond the
// QSOs. Like ADIFExportOptions it is a struct rather than a parameter list
// because the members are all strings.
type CabrilloExportOptions struct {
	ContestName string
	StationCall string
	// MyGridsquare is the contest QTH, available as an exchange field for the
	// VHF/UHF contests that send a locator.
	MyGridsquare string
	// MyDOK is the station's own DOK, available as the "my_dok" exchange
	// field for DOK-exchange contests such as WAG.
	MyDOK string
	// CustomFieldsJSON lists the contest's per-QSO custom fields, so one can
	// be placed in an exchange slot.
	CustomFieldsJSON string
	// MappingJSON is the contest's exchange layout. Empty means the
	// historical sent=RST+ITU / received=RST+CQ arrangement.
	MappingJSON string
}

// ExportCabrillo writes the QSO list to w as a Cabrillo 3.0 contest log.
//
// The QSO line's fixed spine (frequency, mode, date, time, and the two
// callsigns) is dictated by the format; everything after each callsign is the
// contest's exchange, and which Noctalum fields go there — and in what order —
// comes from the contest's mapping. See internal/server/cabrillo_mapping.go.
//
// Operators normally still need to fine-tune the header categories before
// submission; Noctalum writes a conservative multi-op/fixed/one-transmitter
// set.
func ExportCabrillo(w io.Writer, qsos []store.QSO, opts CabrilloExportOptions) error {
	header := []string{
		"START-OF-LOG: 3.0",
		"CREATED-BY: Noctalum",
		fmt.Sprintf("CONTEST: %s", cabrilloHeaderContest(opts.MappingJSON, opts.ContestName)),
		fmt.Sprintf("CALLSIGN: %s", strings.ToUpper(opts.StationCall)),
		"CATEGORY-OPERATOR: MULTI-OP",
		"CATEGORY-STATION: FIXED",
		"CATEGORY-TRANSMITTER: ONE",
	}
	for _, h := range header {
		if _, err := fmt.Fprintln(w, h); err != nil {
			return err
		}
	}
	customFields := parseCustomFieldDefs(opts.CustomFieldsJSON)
	sent, received := resolveCabrilloMapping(opts.MappingJSON, customFields)
	myCall := strings.ToUpper(opts.StationCall)
	ctx := cabrilloLineContext{
		MyGridsquare: opts.MyGridsquare,
		MyDOK:        opts.MyDOK,
		EmptyNrZero:  cabrilloEmptyNrZero(opts.MappingJSON),
	}
	for _, q := range qsos {
		extras := parseExtras(q.Extras)
		var b strings.Builder
		t := q.Time.UTC()
		fmt.Fprintf(&b, "QSO: %5s %2s %s %04s", cabrilloFreq(q), cabrilloMode(q.Mode),
			t.Format("2006-01-02"), t.Format("1504"))
		group := func(call string, keys []string) {
			fmt.Fprintf(&b, " %-13s", call)
			for _, k := range keys {
				fmt.Fprintf(&b, " %-*s", cabrilloFieldWidth(k),
					cabrilloExchangeValue(k, q, ctx, extras))
			}
		}
		group(myCall, sent)
		group(strings.ToUpper(q.Callsign), received)
		// The final column keeps its padding rather than being trimmed: that
		// is what Noctalum has always written, and preserving it keeps an
		// unmapped contest's file byte-identical to before.
		if _, err := fmt.Fprintln(w, b.String()); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(w, "END-OF-LOG:")
	return err
}

// cabrilloBandFreqs is the frequency column written for a QSO that has a
// band but no QRG (typed in by hand without a rig). Below 50 MHz Cabrillo
// wants kHz, so the band's lower edge stands in; from 50 MHz up the spec's
// own band designators are the standard spelling.
var cabrilloBandFreqs = map[string]string{
	"2200m":  "136",
	"630m":   "472",
	"160m":   "1800",
	"80m":    "3500",
	"60m":    "5351",
	"40m":    "7000",
	"30m":    "10100",
	"20m":    "14000",
	"17m":    "18068",
	"15m":    "21000",
	"12m":    "24890",
	"10m":    "28000",
	"6m":     "50",
	"4m":     "70",
	"2m":     "144",
	"1.25m":  "222",
	"70cm":   "432",
	"33cm":   "902",
	"23cm":   "1.2G",
	"13cm":   "2.3G",
	"9cm":    "3.4G",
	"6cm":    "5.7G",
	"3cm":    "10G",
	"1.25cm": "24G",
	"6mm":    "47G",
	"4mm":    "75G",
	"2.5mm":  "122G",
	"2mm":    "134G",
	"1mm":    "241G",
}

// cabrilloFreq is the QSO line's frequency column: the logged QRG in kHz,
// or the band's standard frequency when no QRG was recorded.
func cabrilloFreq(q store.QSO) string {
	if q.FreqHz > 0 {
		return strconv.FormatInt(q.FreqHz/1000, 10)
	}
	if f, ok := cabrilloBandFreqs[strings.ToLower(strings.TrimSpace(q.Band))]; ok {
		return f
	}
	return "0"
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
