package server

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

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
func ExportADIF(w io.Writer, qsos []store.QSO, programID, programVersion, customFieldsJSON string) error {
	header := fmt.Sprintf("ADIF export from %s %s\n", programID, programVersion)
	if _, err := io.WriteString(w, header); err != nil {
		return err
	}
	writeField(w, "ADIF_VER", "3.1.4")
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
			writeField(w, "NAME", q.Name)
		}
		writeField(w, "QSO_DATE", q.Time.UTC().Format("20060102"))
		writeField(w, "TIME_ON", q.Time.UTC().Format("150405"))
		writeField(w, "BAND", strings.ToLower(q.Band))
		if q.FreqHz > 0 {
			mhz := float64(q.FreqHz) / 1_000_000.0
			writeField(w, "FREQ", strconv.FormatFloat(mhz, 'f', 6, 64))
		}
		writeField(w, "MODE", strings.ToUpper(q.Mode))
		writeField(w, "RST_SENT", q.RSTSent)
		writeField(w, "RST_RCVD", q.RSTReceived)
		if q.Locator != "" {
			writeField(w, "GRIDSQUARE", q.Locator)
		}
		if q.ITUZone != "" {
			writeField(w, "ITUZ", q.ITUZone)
		}
		if q.CQZone != "" {
			writeField(w, "CQZ", q.CQZone)
		}
		if q.Lighthouse != "" {
			writeField(w, "ARLHS", q.Lighthouse)
		}
		writeField(w, "OPERATOR", q.Operator)
		writeField(w, "STATION_CALLSIGN", q.StationCall)
		if q.ContestName != "" {
			writeField(w, "CONTEST_ID", q.ContestName)
		}
		if q.Notes != "" {
			writeField(w, "COMMENT", q.Notes)
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
				writeField(w, appPrefix+adifFieldName(cf.Name), val)
			}
		}
		if _, err := io.WriteString(w, "<EOR>\n\n"); err != nil {
			return err
		}
	}
	return nil
}

func writeField(w io.Writer, name, value string) {
	if value == "" {
		return
	}
	fmt.Fprintf(w, "<%s:%d>%s ", name, len(value), value)
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
		"rst_sent", "rst_received", "locator", "itu_zone", "cq_zone",
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
		row := []string{
			strconv.FormatInt(q.ID, 10),
			q.Time.UTC().Format(time.RFC3339),
			q.Callsign, q.Name, q.Band, strconv.FormatInt(q.FreqHz, 10), q.Mode,
			q.RSTSent, q.RSTReceived, q.Locator, q.ITUZone, q.CQZone,
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
