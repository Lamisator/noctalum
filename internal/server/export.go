package server

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/contestlog/contestlog/internal/store"
)

// ExportADIF writes the QSO list to w in ADIF 3.x format.
func ExportADIF(w io.Writer, qsos []store.QSO, programID, programVersion string) error {
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

// ExportCSV writes the QSO list to w as CSV.
func ExportCSV(w io.Writer, qsos []store.QSO) error {
	cw := csv.NewWriter(w)
	defer cw.Flush()
	if err := cw.Write([]string{
		"id", "time_utc", "callsign", "name", "band", "freq_hz", "mode",
		"rst_sent", "rst_received", "locator", "itu_zone", "cq_zone",
		"lighthouse", "operator", "station_call", "contest_name", "notes",
	}); err != nil {
		return err
	}
	for _, q := range qsos {
		if err := cw.Write([]string{
			strconv.FormatInt(q.ID, 10),
			q.Time.UTC().Format(time.RFC3339),
			q.Callsign, q.Name, q.Band, strconv.FormatInt(q.FreqHz, 10), q.Mode,
			q.RSTSent, q.RSTReceived, q.Locator, q.ITUZone, q.CQZone,
			q.Lighthouse, q.Operator, q.StationCall, q.ContestName, q.Notes,
		}); err != nil {
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
		"CREATED-BY: ContestLog",
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
