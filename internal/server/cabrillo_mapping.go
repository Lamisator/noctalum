package server

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/noctalum/noctalum/internal/store"
)

// Cabrillo's QSO line is positional, not tagged: everything after the fixed
// spine is "the exchange", and which values go there is decided by the
// contest's rules rather than by any spec. Cabrillo 3.0 only fixes
//
//	QSO: <freq> <mode> <date> <time> <sent group> <received group>
//
// where each group starts with a callsign and is followed by whatever that
// contest asks for — a signal report and a zone for CQ WW, a serial number and
// a section for ARRL Sweepstakes, a DOK for WAG, and so on.
//
// So where the ADIF mapping answers "which tag does this field land on", the
// Cabrillo mapping answers "which fields fill the exchange, in what order".

// cabrilloExchangeField is one Noctalum data field that may be placed in a
// Cabrillo exchange slot.
//
// Mirrors CABRILLO_EXCHANGE_FIELDS in internal/server/web/app.js — keep in sync.
type cabrilloExchangeField struct {
	// Key identifies the Noctalum field, matching the keys the log column and
	// QSO mask editors use so the UI can label them from one set of
	// translations. Per-QSO custom fields use the "cf:<name>" form.
	Key string
	// Width is the column width the value is left-padded to. Cabrillo is
	// whitespace-delimited in practice, but robot parsers for several
	// contests still key off column positions, so the widths Noctalum has
	// always written are preserved per field rather than made uniform.
	Width int
}

// cabrilloExchangeFields lists the built-in fields offered for an exchange
// slot. Callsigns are absent deliberately: they are part of the fixed spine,
// not the exchange.
var cabrilloExchangeFields = []cabrilloExchangeField{
	{Key: "rst_sent", Width: 3},
	{Key: "rst_received", Width: 3},
	{Key: "nr_sent", Width: 6},
	{Key: "nr_received", Width: 6},
	{Key: "itu", Width: 6},
	{Key: "cq", Width: 6},
	{Key: "dok", Width: 6},
	{Key: "my_dok", Width: 6},
	// The WAG exchange in one column: German stations give a DOK, everyone
	// else a serial number.
	{Key: "dok_or_nr", Width: 6},
	{Key: "locator", Width: 6},
	{Key: "my_locator", Width: 6},
	{Key: "name", Width: 10},
	{Key: "lighthouse", Width: 8},
	{Key: "band", Width: 6},
	{Key: "operator", Width: 10},
}

// cabrilloDefaultSent / cabrilloDefaultReceived reproduce exactly what
// Noctalum has always written, so a contest with no mapping exports
// byte-identically to before.
var (
	cabrilloDefaultSent     = []string{"rst_sent", "itu"}
	cabrilloDefaultReceived = []string{"rst_received", "cq"}
)

// cabrilloCustomKeyPrefix namespaces a per-QSO custom field in an exchange
// slot, matching the ADIF mapping blob's convention.
const cabrilloCustomKeyPrefix = "cf:"

// cabrilloMapping is a contest's stored exchange layout.
type cabrilloMapping struct {
	Sent     []string `json:"sent"`
	Received []string `json:"received"`
	// EmptyNrZero writes "000" into a received-serial slot (nr_received, or
	// dok_or_nr without a DOK) when the QSO has no received number, for
	// contest robots that reject a line with a missing column.
	EmptyNrZero bool `json:"empty_nr_zero,omitempty"`
	// Contest is the value for the CONTEST: header line, i.e. the name the
	// sponsor's log robot expects ("DARC-WAG"). Empty means the contest's
	// own name, as Noctalum has always written.
	Contest string `json:"contest,omitempty"`
}

// cabrilloHeaderContest returns the CONTEST: header value: the mapping's
// explicit name when set, otherwise the upper-cased contest name exactly as
// before. The explicit name goes through cabrilloToken, so one typed with
// spaces or umlauts still yields a single ASCII word ("darc wag" ->
// "DARC-WAG"); the fallback is left untouched so existing exports do not
// change.
func cabrilloHeaderContest(mappingJSON, contestName string) string {
	var m cabrilloMapping
	if json.Unmarshal([]byte(mappingJSON), &m) == nil && strings.TrimSpace(m.Contest) != "" {
		return cabrilloToken(m.Contest)
	}
	return strings.ToUpper(contestName)
}

// cabrilloEmptyNrZero reports whether the contest's mapping asks for "000" in
// place of a missing received serial. A missing or malformed blob means no.
func cabrilloEmptyNrZero(mappingJSON string) bool {
	var m cabrilloMapping
	if json.Unmarshal([]byte(mappingJSON), &m) != nil {
		return false
	}
	return m.EmptyNrZero
}

// cabrilloLineContext carries the per-export values an exchange slot may
// need besides the QSO itself.
type cabrilloLineContext struct {
	MyGridsquare string
	MyDOK        string
	EmptyNrZero  bool
}

// resolveCabrilloMapping decodes a contest's stored blob into the ordered
// field keys for the sent and received exchange groups.
//
// Unlike the ADIF blob this one is a full list rather than a set of overrides,
// because order is the whole point and there is no per-slot default to fall
// back to. An empty or malformed blob yields the historical layout, and an
// empty list on one side is honoured — some contests send an exchange and
// receive nothing but a report.
//
// Keys naming neither a built-in exchange field nor a custom field of this
// contest are dropped, so a hand-edited blob or a contest whose custom fields
// were renamed degrades to a shorter line instead of writing empty columns
// that shift every following field out of position.
func resolveCabrilloMapping(mappingJSON string, customFields []customFieldDef) (sent, received []string) {
	if strings.TrimSpace(mappingJSON) == "" {
		return cabrilloDefaultSent, cabrilloDefaultReceived
	}
	var m cabrilloMapping
	if err := json.Unmarshal([]byte(mappingJSON), &m); err != nil {
		return cabrilloDefaultSent, cabrilloDefaultReceived
	}
	if m.Sent == nil && m.Received == nil {
		return cabrilloDefaultSent, cabrilloDefaultReceived
	}
	known := make(map[string]bool, len(cabrilloExchangeFields)+len(customFields))
	for _, f := range cabrilloExchangeFields {
		known[f.Key] = true
	}
	for _, cf := range customFields {
		if cf.Name != "" {
			known[cabrilloCustomKeyPrefix+cf.Name] = true
		}
	}
	filter := func(keys []string) []string {
		out := make([]string, 0, len(keys))
		for _, k := range keys {
			if known[k] {
				out = append(out, k)
			}
		}
		return out
	}
	return filter(m.Sent), filter(m.Received)
}

// cabrilloFieldWidth returns the column width for an exchange field. Custom
// fields have no historical width to preserve, so they get the same 6 columns
// as most built-in exchange values.
func cabrilloFieldWidth(key string) int {
	for _, f := range cabrilloExchangeFields {
		if f.Key == key {
			return f.Width
		}
	}
	return 6
}

// cabrilloExchangeValue returns the value for one exchange slot. Everything is
// upper-cased and stripped of whitespace: Cabrillo is a whitespace-delimited
// format, so a value containing a space would silently become two columns and
// shift the rest of the line.
//
// Serial numbers are always zero-padded to three digits ("007"), the form
// contest robots and adjudicators compare against; serials past 999 keep
// their natural width.
func cabrilloExchangeValue(key string, q store.QSO, ctx cabrilloLineContext, extras map[string]string) string {
	var v string
	if name, ok := strings.CutPrefix(key, cabrilloCustomKeyPrefix); ok {
		v = extras[name]
	} else {
		switch key {
		case "rst_sent":
			v = q.RSTSent
		case "rst_received":
			v = q.RSTReceived
		case "nr_sent":
			v = formatSerial(q.NrSent, true)
		case "nr_received":
			v = formatSerial(q.NrReceived, true)
			if v == "" && ctx.EmptyNrZero {
				v = "000"
			}
		case "itu":
			v = q.ITUZone
		case "cq":
			v = q.CQZone
		case "dok":
			v = q.DOK
		case "my_dok":
			v = ctx.MyDOK
		case "dok_or_nr":
			// A logged DOK wins; "NM" is a DOK value like any other and is
			// never filled in on the operator's behalf.
			v = q.DOK
			if strings.TrimSpace(v) == "" {
				v = formatSerial(q.NrReceived, true)
				if v == "" && ctx.EmptyNrZero {
					v = "000"
				}
			}
		case "locator":
			v = q.Locator
		case "my_locator":
			v = ctx.MyGridsquare
		case "name":
			v = q.Name
		case "lighthouse":
			v = q.Lighthouse
		case "band":
			v = q.Band
		case "operator":
			v = q.Operator
		}
	}
	return cabrilloToken(v)
}

// cabrilloToken makes a value safe to drop into a whitespace-delimited column:
// upper-cased, internal whitespace collapsed to a single "-", and non-ASCII
// dropped. The Cabrillo spec is ASCII-only, and contest robots reject a line
// whose column count does not match the contest's expected exchange.
func cabrilloToken(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	lastDash := false
	for _, r := range strings.ToUpper(s) {
		switch {
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			if b.Len() > 0 && !lastDash {
				b.WriteRune('-')
				lastDash = true
			}
		case r < 0x80:
			b.WriteRune(r)
			lastDash = false
		}
	}
	return strings.TrimRight(b.String(), "-")
}

// normalizeMyDOK validates the station's own DOK as entered in the contest
// settings: trimmed, upper-cased, letters and digits only. Special DOKs run
// longer than the usual letter + two digits ("50JDARC"), so only the length
// is capped rather than the shape enforced.
func normalizeMyDOK(s string) (string, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) > 12 {
		return "", errors.New("my DOK is too long (max 12 characters)")
	}
	for _, r := range s {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return "", errors.New("my DOK may only contain letters and digits")
		}
	}
	return s, nil
}
