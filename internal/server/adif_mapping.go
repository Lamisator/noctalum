package server

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/noctalum/noctalum/internal/adif"
	"github.com/noctalum/noctalum/internal/store"
)

// adifSourceField is one Noctalum data field that can end up in an ADIF
// export, together with the ADIF tag it lands on out of the box.
//
// The list below is the authoritative description of Noctalum's ADIF mapping:
// ExportADIF walks it in order, and the contest-settings mapping editor renders
// it. Adding a QSO column means adding a row here — nowhere else.
//
// Mirrors ADIF_SOURCE_FIELDS in internal/server/web/app.js — keep in sync.
type adifSourceField struct {
	// Key identifies the Noctalum field. It matches the keys used by
	// builtinLogColumns and the QSO mask layout so the UI can label all
	// three from one set of translations.
	Key string
	// Default is the ADIF tag this field maps to when the operator has not
	// changed anything. Empty means the field is not exported by default —
	// the operator can still map it to a tag of their choosing.
	Default string
	// Fixed marks a mapping the operator cannot change, because the field
	// does not correspond to a single ADIF tag.
	Fixed bool
}

// adifSourceFields lists every Noctalum data field in the order ExportADIF
// emits it. The order is deliberate and matches what Noctalum has always
// written, so re-mapping nothing produces a byte-identical file.
var adifSourceFields = []adifSourceField{
	{Key: "callsign", Default: "CALL"},
	{Key: "name", Default: "NAME"},
	// The QSO timestamp feeds two tags (QSO_DATE + TIME_ON) out of one
	// value, so there is no single tag to re-point it at.
	{Key: "time", Default: "QSO_DATE", Fixed: true},
	{Key: "band", Default: "BAND"},
	{Key: "freq", Default: "FREQ"},
	{Key: "mode", Default: "MODE"},
	{Key: "rst_sent", Default: "RST_SENT"},
	{Key: "rst_received", Default: "RST_RCVD"},
	{Key: "nr_sent", Default: "STX"},
	{Key: "nr_received", Default: "SRX"},
	{Key: "dok", Default: "DARC_DOK"},
	{Key: "locator", Default: "GRIDSQUARE"},
	{Key: "itu", Default: "ITUZ"},
	{Key: "cq", Default: "CQZ"},
	// ADIF has no lighthouse field; the idiomatic mapping is the
	// SIG/SIG_INFO pair, so SIG_INFO carries the reference and SIG=ARLHS
	// is written alongside it (see adifCompanion).
	{Key: "lighthouse", Default: "SIG_INFO"},
	{Key: "operator", Default: "OPERATOR"},
	{Key: "station_call", Default: "STATION_CALLSIGN"},
	{Key: "my_locator", Default: "MY_GRIDSQUARE"},
	{Key: "contest_name", Default: "CONTEST_ID"},
	{Key: "notes", Default: "NOTES"},
	// Great-circle distance between the contest QTH and the worked station,
	// computed from the two locators. Noctalum has never exported it — it is
	// offered here so an operator who wants ADIF's DISTANCE can switch it on
	// without us changing what everyone else's file looks like.
	{Key: "distance", Default: ""},
}

// adifCompanion returns an extra tag/value pair that belongs with a source
// field, but only while that field still sits on its default tag. Once the
// operator re-points the field somewhere else the companion no longer makes
// sense: SIG=ARLHS next to a WWFF_REF would claim the wrong programme, and a
// SUBMODE next to a free-text tag has nothing to qualify.
func adifCompanion(key, effectiveTag string, q store.QSO) (tag, value string) {
	switch key {
	case "lighthouse":
		if effectiveTag == "SIG_INFO" {
			return "SIG", "ARLHS"
		}
	case "mode":
		if effectiveTag == "MODE" {
			if _, submode := adifModeSubmode(q.Mode); submode != "" {
				return "SUBMODE", submode
			}
		}
	}
	return "", ""
}

// adifCustomKeyPrefix namespaces a per-QSO custom field inside the mapping
// blob, so "cf:Region" cannot collide with a built-in source key.
const adifCustomKeyPrefix = "cf:"

// resolveADIFMapping turns a contest's stored override blob into the effective
// ADIF tag for every source field. An empty value means "do not export this
// field".
//
// The blob holds overrides only — a key that is absent keeps its default. That
// matters for durability: a contest configured today must keep exporting
// correctly when a later Noctalum adds a source field or changes a default,
// and storing the full resolved map would freeze it at today's answer instead.
// A key present with an empty value is the operator explicitly switching a
// field off, which is why absent and empty cannot mean the same thing.
//
// Custom fields are carried through under their "cf:<name>" keys rather than
// being resolved here: their default depends on the program ID (the
// APP_<PROGRAMID>_ fallback), which only the exporter knows. The caller looks
// one up with comma-ok and falls back to the name-derived tag when it is
// absent.
//
// Overrides naming something that is not an addressable ADIF tag are ignored
// rather than honoured, so a hand-edited or downgraded blob degrades to the
// default export instead of producing a file importers reject.
func resolveADIFMapping(mappingJSON string) map[string]string {
	out := make(map[string]string, len(adifSourceFields))
	for _, f := range adifSourceFields {
		out[f.Key] = f.Default
	}
	if strings.TrimSpace(mappingJSON) == "" {
		return out
	}
	var overrides map[string]string
	if err := json.Unmarshal([]byte(mappingJSON), &overrides); err != nil {
		return out
	}
	for _, f := range adifSourceFields {
		tag, ok := overrides[f.Key]
		if !ok || f.Fixed {
			continue
		}
		tag = strings.ToUpper(strings.TrimSpace(tag))
		if tag == "" {
			out[f.Key] = "" // explicitly switched off
			continue
		}
		if !adifMappableTarget(tag) {
			continue
		}
		out[f.Key] = tag
	}
	for key, tag := range overrides {
		name, ok := strings.CutPrefix(key, adifCustomKeyPrefix)
		if !ok || name == "" {
			continue
		}
		tag = strings.ToUpper(strings.TrimSpace(tag))
		if tag != "" && !adifMappableTarget(tag) {
			continue
		}
		out[key] = tag
	}
	return out
}

// adifCustomFieldTag decides which ADIF tag a per-QSO custom field's value is
// written under: the operator's explicit choice from the mapping editor when
// there is one, otherwise the historical name-derived rule (a field named
// after a standard ADIF tag lands on that tag; anything else goes to the
// APP_<PROGRAMID>_<NAME> namespace ADIF reserves for application data).
//
// The second return is false when the operator switched the field off.
func adifCustomFieldTag(name string, mapping map[string]string, appPrefix string) (string, bool) {
	if tag, ok := mapping[adifCustomKeyPrefix+name]; ok {
		return tag, tag != ""
	}
	tag := adifFieldName(name)
	if _, ok := adif.Exportable(tag); !ok {
		tag = appPrefix + tag
	}
	return tag, true
}

// adifMappableTarget reports whether a tag may be used as a mapping target.
// Everything the spec defines is allowed except the import-only fields:
// exporting one of those produces a file strict validators reject, and the
// spec names a replacement for each, so there is never a reason to pick one.
func adifMappableTarget(tag string) bool {
	f, ok := adif.Lookup(tag)
	return ok && f.Status != adif.StatusDeprecated
}

// adifSourceValue returns the exportable value of one Noctalum source field,
// or "" when this QSO has nothing to say for it. myGridsquare is the contest
// QTH — the logging station's own locator. nrPadded is the contest's serial
// padding setting and only affects the two serial fields.
func adifSourceValue(key string, q store.QSO, myGridsquare string, nrPadded bool) string {
	switch key {
	case "callsign":
		return q.Callsign
	case "name":
		return q.Name
	case "band":
		return strings.ToLower(q.Band)
	case "freq":
		if q.FreqHz <= 0 {
			return ""
		}
		return strconv.FormatFloat(float64(q.FreqHz)/1_000_000.0, 'f', 6, 64)
	case "mode":
		mode, _ := adifModeSubmode(q.Mode)
		return mode
	case "rst_sent":
		return q.RSTSent
	case "rst_received":
		return q.RSTReceived
	case "nr_sent":
		// formatSerial omits an unset serial so 0 doesn't leak into
		// non-contest QSOs that were imported without a sequence, and applies
		// the contest's zero-padding. ADIF's Integer type is "a sequence of
		// Digits", so leading zeros are conforming; importers that parse STX
		// into an int simply drop them again.
		return formatSerial(q.NrSent, nrPadded)
	case "nr_received":
		return formatSerial(q.NrReceived, nrPadded)
	case "dok":
		return strings.ToUpper(q.DOK)
	case "locator":
		// Uppercase to match MY_GRIDSQUARE and the LotW/eQSL/DXCC
		// convention. Mixed-case locators are legal per spec but some award
		// trackers normalise on upload — emit them upper already so
		// re-imports round-trip cleanly.
		return strings.ToUpper(q.Locator)
	case "itu":
		return q.ITUZone
	case "cq":
		return q.CQZone
	case "lighthouse":
		return q.Lighthouse
	case "operator":
		return q.Operator
	case "station_call":
		return q.StationCall
	case "my_locator":
		// Award trackers (LotW, eQSL, VUCC) rely on the logging station's own
		// locator to credit worked-grids/DXCC-from-here.
		return strings.ToUpper(myGridsquare)
	case "contest_name":
		return q.ContestName
	case "notes":
		return q.Notes
	case "distance":
		km, ok := LocatorDistanceKm(myGridsquare, q.Locator)
		if !ok {
			return ""
		}
		return strconv.FormatFloat(km, 'f', 1, 64)
	}
	return ""
}
