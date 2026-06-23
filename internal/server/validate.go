package server

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// callsignRe matches plausible amateur callsigns including ITU prefix and
	// portable suffixes. The grammar is:
	//   [PREFIX/]BASE[/SUFFIX[/SUFFIX...]]
	// where BASE is the conventional 1-3 alphanumeric prefix, a digit, more
	// alphanumerics, ending on a letter — e.g. DM2LAP, G0ABC, 4U1WB. PREFIX
	// is an optional 1-4 alphanumeric ITU country prefix written before the
	// base call with a slash (F/DM2LAP, OE/DJ3KA), and SUFFIX is one or more
	// trailing /-separated tokens (/P, /M, /MM, /AM, /QRP, …).
	callsignRe = regexp.MustCompile(`^([A-Z0-9]{1,4}/)?[A-Z0-9]{1,3}[0-9][A-Z0-9]*[A-Z](/[A-Z0-9]+)*$`)
	locatorRe  = regexp.MustCompile(`^[A-R]{2}[0-9]{2}([A-X]{2})?$`)
)

// ValidCallsign checks for a plausible amateur radio callsign. The grammar
// admits an optional leading ITU prefix (F/DM2LAP) and one or more trailing
// portable / status suffixes (DM2LAP/P, DM2LAP/MM, F/DM2LAP/QRP).
func ValidCallsign(cs string) bool {
	cs = strings.ToUpper(strings.TrimSpace(cs))
	if cs == "" || len(cs) > 20 {
		return false
	}
	return callsignRe.MatchString(cs)
}

// BaseCallsign returns the "home" callsign component of cs by stripping the
// optional leading ITU prefix (F/) and the trailing portable/status
// suffix(es) (/P, /MM, /QRP). It returns the longest slash-separated token
// that contains at least one digit and is at least 3 characters — that is
// the heuristic for distinguishing a real base call (DM2LAP, G0ABC) from
// short prefix/suffix tokens (F, P, MM, QRP).
//
// The base call is what should be passed to external lookups (QRZ.com), to
// the per-callsign DOK cache, and to anything else that should resolve to
// the operator's home identity rather than to their current portable
// operating context. The on-screen / on-paper QSO record still carries the
// full operating string (e.g. "F/DM2LAP/P") in store.QSO.Callsign.
func BaseCallsign(cs string) string {
	cs = strings.ToUpper(strings.TrimSpace(cs))
	if cs == "" || !strings.Contains(cs, "/") {
		return cs
	}
	base := ""
	for _, p := range strings.Split(cs, "/") {
		if len(p) < 3 || !strings.ContainsAny(p, "0123456789") {
			continue
		}
		if len(p) > len(base) {
			base = p
		}
	}
	if base == "" {
		return cs
	}
	return base
}

// ValidLocator checks Maidenhead grid square: 4 or 6 character locators.
func ValidLocator(loc string) bool {
	if loc == "" {
		return true // optional field
	}
	return locatorRe.MatchString(strings.ToUpper(strings.TrimSpace(loc)))
}

// ValidZone returns true if zone is empty or a positive integer in range [1,90].
func ValidZone(z string) bool {
	z = strings.TrimSpace(z)
	if z == "" {
		return true
	}
	var n int
	if _, err := fmt.Sscanf(z, "%d", &n); err != nil {
		return false
	}
	return n >= 1 && n <= 90
}

// ModeKind classifies a mode for report-format validation.
type ModeKind int

const (
	ModeUnknown ModeKind = iota
	ModeCW
	ModeVoice
	ModeDigital
)

// ClassifyMode maps a mode label to its kind.
func ClassifyMode(mode string) ModeKind {
	switch strings.ToUpper(strings.TrimSpace(mode)) {
	case "CW":
		return ModeCW
	case "SSB", "USB", "LSB", "FM", "AM":
		return ModeVoice
	case "RTTY", "FT8", "FT4", "PSK31", "PSK63", "JT65", "JT9", "MFSK", "OLIVIA", "DIGI":
		return ModeDigital
	}
	return ModeUnknown
}

// DefaultRST returns the conventional default signal report for a mode:
// "59" for voice, "599" for CW/digital, empty string for unknown modes.
func DefaultRST(mode string) string {
	switch ClassifyMode(mode) {
	case ModeVoice:
		return "59"
	case ModeCW, ModeDigital:
		return "599"
	}
	return ""
}

// ValidReport returns whether the report is well-formed for the given mode.
func ValidReport(report, mode string) bool {
	r := strings.TrimSpace(report)
	if r == "" {
		return false
	}
	switch ClassifyMode(mode) {
	case ModeCW:
		// RST: 3 digits, R 1-5, S 1-9, T 1-9
		if len(r) != 3 {
			return false
		}
		return r[0] >= '1' && r[0] <= '5' && r[1] >= '1' && r[1] <= '9' && r[2] >= '1' && r[2] <= '9'
	case ModeVoice:
		// RS: 2 digits R 1-5, S 1-9
		if len(r) != 2 {
			return false
		}
		return r[0] >= '1' && r[0] <= '5' && r[1] >= '1' && r[1] <= '9'
	case ModeDigital:
		// Permissive: digits with optional sign and decimal (e.g. -12, +03, 599)
		matched, _ := regexp.MatchString(`^[+\-]?\d{1,3}(\.\d+)?$`, r)
		return matched
	}
	// Unknown mode: accept anything 1-10 chars
	return len(r) <= 10
}

// BandFromHz returns the standard band label (e.g. "40m") for a frequency in Hz.
// Returns "" if the frequency does not fall inside a known amateur band.
func BandFromHz(hz int64) string {
	khz := hz / 1000
	switch {
	case khz >= 135 && khz <= 138:
		return "2200m"
	case khz >= 472 && khz <= 479:
		return "630m"
	case khz >= 1800 && khz <= 2000:
		return "160m"
	case khz >= 3500 && khz <= 4000:
		return "80m"
	case khz >= 5258 && khz <= 5410:
		return "60m"
	case khz >= 7000 && khz <= 7300:
		return "40m"
	case khz >= 10100 && khz <= 10150:
		return "30m"
	case khz >= 14000 && khz <= 14350:
		return "20m"
	case khz >= 18068 && khz <= 18168:
		return "17m"
	case khz >= 21000 && khz <= 21450:
		return "15m"
	case khz >= 24890 && khz <= 24990:
		return "12m"
	case khz >= 28000 && khz <= 29700:
		return "10m"
	case khz >= 50000 && khz <= 54000:
		return "6m"
	case khz >= 70000 && khz <= 70500:
		return "4m"
	case khz >= 144000 && khz <= 148000:
		return "2m"
	case khz >= 222000 && khz <= 225000:
		return "1.25m"
	case khz >= 420000 && khz <= 450000:
		return "70cm"
	case khz >= 902000 && khz <= 928000:
		return "33cm"
	case khz >= 1240000 && khz <= 1300000:
		return "23cm"
	}
	return ""
}
