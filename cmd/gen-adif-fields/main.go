// Command gen-adif-fields regenerates the ADIF QSO-field catalogue that the
// contest-settings field picker and the ADIF exporter share.
//
// It downloads an ADIF specification release from adif.org, parses the
// "QSO Fields" table out of it, merges the hand-maintained presentation
// metadata in meta.json (group + EN/DE label + status) and writes:
//
//	internal/adif/fields_gen.go            — the Go catalogue (exporter)
//	internal/server/web/adif-fields.js     — the browser catalogue (picker)
//
// Run it after an ADIF release:
//
//	go run ./cmd/gen-adif-fields
//
// The generator fails loudly when the spec gained or lost a field relative to
// meta.json. That is deliberate: a new ADIF field needs a German label and a
// group before it can be shown in the UI, and silently dropping it would hide
// the addition from operators.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
)

const defaultSpecURL = "https://www.adif.org/317/ADIF_317.htm"

// closedEnums lists the enumeration anchors small and stable enough to be
// worth offering as a dropdown in the QSO entry mask. The open-ended ones
// (DXCC entity codes, primary/secondary subdivisions, sponsored awards,
// contest IDs) stay free-text: they run to hundreds of rows, are region
// specific, and a wrong pick is worse than a typo the operator can see.
var closedEnums = map[string]bool{
	"ANT_PATH_Enumeration":          true,
	"ARRL_Section_Enumeration":      true,
	"Band_Enumeration":              true,
	"Continent_Enumeration":         true,
	"EQSL_AG_Enumeration":           true,
	"Mode_Enumeration":              true,
	"Morse_Key_Type_Enumeration":    true,
	"Propagation_Mode_Enumeration":  true,
	"QSLRcvd_Enumeration":           true,
	"QSLSent_Enumeration":           true,
	"QSLVia_Enumeration":            true,
	"QSOComplete_Enumeration":       true,
	"QSODownloadStatus_Enumeration": true,
	"QSOUploadStatus_Enumeration":   true,
	"Region_Enumeration":            true,
	"Submode_Enumeration":           true,
}

type meta struct {
	Group  string `json:"group"`
	Status string `json:"status"`
	EN     string `json:"en"`
	DE     string `json:"de"`
}

type field struct {
	Name     string
	Type     string // ADIF data type, verbatim from the spec
	Input    string // UI input kind: text|number|select|date|time|textarea
	Options  []string
	Group    string
	Status   string // "" | builtin | intl | deprecated
	Intl     string // sibling _INTL field, when the spec defines one
	Replaces string // deprecated fields: the field to use instead
	LabelEN  string
	LabelDE  string
}

var (
	rowRe   = regexp.MustCompile(`(?s)<tr id="QSO_Field_([A-Z0-9_]+)">(.*?)</tr>`)
	cellRe  = regexp.MustCompile(`(?s)<td[^>]*>(.*?)</td>`)
	enumRe  = regexp.MustCompile(`(?s)<tr[^>]*>(.*?)</tr>`)
	ecellRe = regexp.MustCompile(`(?s)<t[dh][^>]*>(.*?)</t[dh]>`)
	hrefRe  = regexp.MustCompile(`href="#([A-Za-z0-9_]+)"`)
	tagRe   = regexp.MustCompile(`<[^>]+>`)
	wsRe    = regexp.MustCompile(`\s+`)
	depRe   = regexp.MustCompile(`^import-only\s*:`)
	useRe   = regexp.MustCompile(`use ([A-Z0-9_]+) instead`)
	verRe   = regexp.MustCompile(`name="adifversion" content="([^"]+)"`)
)

func main() {
	specURL := flag.String("spec", defaultSpecURL, "ADIF specification URL")
	metaPath := flag.String("meta", "cmd/gen-adif-fields/meta.json", "path to the presentation metadata")
	goOut := flag.String("go-out", "internal/adif/fields_gen.go", "generated Go catalogue")
	jsOut := flag.String("js-out", "internal/server/web/adif-fields.js", "generated browser catalogue")
	flag.Parse()

	src, err := fetch(*specURL)
	if err != nil {
		fatal("fetch spec: %v", err)
	}
	version := "unknown"
	if m := verRe.FindStringSubmatch(src); m != nil {
		version = m[1]
	}

	metas := map[string]meta{}
	raw, err := os.ReadFile(*metaPath)
	if err != nil {
		fatal("read %s: %v", *metaPath, err)
	}
	if err := json.Unmarshal(raw, &metas); err != nil {
		fatal("parse %s: %v", *metaPath, err)
	}

	fields, err := parseFields(src)
	if err != nil {
		fatal("parse spec: %v", err)
	}

	// Cross-check the spec against meta.json in both directions before
	// emitting anything, so a spec bump can never quietly drop a field.
	byName := map[string]bool{}
	var missing, extra []string
	for _, f := range fields {
		byName[f.Name] = true
		if _, ok := metas[f.Name]; !ok {
			missing = append(missing, f.Name)
		}
	}
	for name := range metas {
		if !byName[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 || len(extra) > 0 {
		fatal("meta.json is out of sync with %s (version %s)\n  new in spec, needs group + EN/DE label: %v\n  no longer in spec, remove: %v",
			*specURL, version, missing, extra)
	}

	for i := range fields {
		m := metas[fields[i].Name]
		fields[i].Group = m.Group
		fields[i].Status = m.Status
		fields[i].LabelEN = m.EN
		fields[i].LabelDE = m.DE
		if byName[fields[i].Name+"_INTL"] {
			fields[i].Intl = fields[i].Name + "_INTL"
		}
	}

	if err := os.WriteFile(*goOut, []byte(renderGo(version, *specURL, fields)), 0o644); err != nil {
		fatal("write %s: %v", *goOut, err)
	}
	if err := os.WriteFile(*jsOut, []byte(renderJS(version, *specURL, fields)), 0o644); err != nil {
		fatal("write %s: %v", *jsOut, err)
	}
	fmt.Printf("ADIF %s: %d QSO fields written to %s and %s\n", version, len(fields), *goOut, *jsOut)
}

func fetch(url string) (string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %s", resp.Status)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	// The spec is served as windows-1252. Every token we read out of it —
	// field names, data-type names, enumeration values — is 7-bit ASCII, so
	// rather than pulling in a charset decoder we drop the high bytes; they
	// only ever occur inside prose we do not extract. (Human-readable labels
	// come from meta.json, which is UTF-8.)
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c < 0x80 {
			out = append(out, c)
		} else {
			out = append(out, ' ')
		}
	}
	return string(out), nil
}

func parseFields(src string) ([]field, error) {
	start := strings.Index(src, `<table id="Field_QSO"`)
	if start < 0 {
		return nil, fmt.Errorf("QSO field table not found")
	}
	end := strings.Index(src[start:], "</table>")
	if end < 0 {
		return nil, fmt.Errorf("QSO field table not terminated")
	}
	table := src[start : start+end]

	rows := rowRe.FindAllStringSubmatch(table, -1)
	if len(rows) == 0 {
		return nil, fmt.Errorf("no QSO field rows matched")
	}
	out := make([]field, 0, len(rows))
	for _, r := range rows {
		cells := cellRe.FindAllStringSubmatch(r[2], -1)
		if len(cells) != 4 {
			return nil, fmt.Errorf("%s: expected 4 cells, got %d", r[1], len(cells))
		}
		f := field{Name: r[1]}
		// The data type is read off the anchor target rather than the cell
		// text: long type names are wrapped across lines in the HTML (so the
		// text reads "Secondary AdministrativeSubdivisionListAlt"), and a
		// cell may carry a trailing deprecation note whose own anchor comes
		// second ("CreditList AwardList (import-only)").
		if m := hrefRe.FindStringSubmatch(cells[1][1]); m != nil {
			f.Type = m[1]
		} else {
			f.Type = strings.Fields(text(cells[1][1]))[0]
		}

		var anchor string
		if m := hrefRe.FindStringSubmatch(cells[2][1]); m != nil {
			anchor = m[1]
		}
		if closedEnums[anchor] {
			f.Options = enumValues(src, anchor)
		}
		desc := text(cells[3][1])
		if depRe.MatchString(desc) {
			if m := useRe.FindStringSubmatch(desc); m != nil {
				f.Replaces = m[1]
			}
		}
		f.Input = inputKind(f.Type, len(f.Options) > 0)
		out = append(out, f)
	}
	return out, nil
}

// enumValues pulls the value column out of an enumeration table. Import-only
// (deprecated) values are skipped: offering them in a dropdown would let an
// operator produce an export that strict validators reject.
func enumValues(src, anchor string) []string {
	i := strings.Index(src, `id="`+anchor+`"`)
	if i < 0 {
		return nil
	}
	j := strings.Index(src[i:], "<table")
	if j < 0 {
		return nil
	}
	j += i
	k := strings.Index(src[j:], "</table>")
	if k < 0 {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for n, r := range enumRe.FindAllStringSubmatch(src[j:j+k], -1) {
		if n == 0 {
			continue // header row
		}
		cells := ecellRe.FindAllStringSubmatch(r[1], -1)
		if len(cells) == 0 {
			continue
		}
		v := text(cells[0][1])
		if v == "" || strings.Contains(v, "(import-only)") || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// inputKind maps an ADIF data type onto the form control the QSO entry mask
// should render. Location (LAT/LON) stays free text — ADIF wants the
// "XDDD MM.MMM" form, which no native input produces.
func inputKind(adifType string, hasOptions bool) string {
	if hasOptions {
		return "select"
	}
	switch adifType {
	case "Date":
		return "date"
	case "Time":
		return "time"
	case "Number", "Integer", "PositiveInteger":
		return "number"
	case "Boolean":
		return "select"
	case "MultilineString", "IntlMultilineString":
		return "textarea"
	default:
		return "text"
	}
}

func text(h string) string {
	h = strings.ReplaceAll(h, "<br />", " ")
	h = tagRe.ReplaceAllString(h, "")
	h = strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`).Replace(h)
	return strings.TrimSpace(wsRe.ReplaceAllString(h, " "))
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "gen-adif-fields: "+format+"\n", args...)
	os.Exit(1)
}

func renderGo(version, specURL string, fields []field) string {
	var b strings.Builder
	fmt.Fprintf(&b, "// Code generated by cmd/gen-adif-fields; DO NOT EDIT.\n")
	fmt.Fprintf(&b, "// Source: %s (ADIF %s)\n\n", specURL, version)
	fmt.Fprintf(&b, "package adif\n\n")
	fmt.Fprintf(&b, "// SpecVersion is the ADIF release this catalogue was generated from.\n")
	fmt.Fprintf(&b, "const SpecVersion = %q\n\n", version)
	fmt.Fprintf(&b, "// Fields is every QSO field defined by the ADIF specification, in spec order.\n")
	fmt.Fprintf(&b, "var Fields = []Field{\n")
	for _, f := range fields {
		fmt.Fprintf(&b, "\t{Name: %q, Type: %q, Input: %q, Group: %q", f.Name, f.Type, f.Input, f.Group)
		if f.Status != "" {
			fmt.Fprintf(&b, ", Status: %q", f.Status)
		}
		if f.Intl != "" {
			fmt.Fprintf(&b, ", Intl: %q", f.Intl)
		}
		if f.Replaces != "" {
			fmt.Fprintf(&b, ", Replaces: %q", f.Replaces)
		}
		if len(f.Options) > 0 {
			fmt.Fprintf(&b, ", Options: []string{")
			for i, o := range f.Options {
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%q", o)
			}
			b.WriteString("}")
		}
		b.WriteString("},\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func renderJS(version, specURL string, fields []field) string {
	var b strings.Builder
	fmt.Fprintf(&b, "// Code generated by cmd/gen-adif-fields; DO NOT EDIT.\n")
	fmt.Fprintf(&b, "// Source: %s (ADIF %s)\n", specURL, version)
	b.WriteString(`//
// The ADIF QSO-field catalogue behind the contest-settings field picker.
//
//   ADIF_FIELDS         — every QSO field in the spec, in spec order:
//                           name    ADIF tag
//                           input   form control: text|number|select|date|time|textarea
//                           options dropdown values (closed enumerations only)
//                           group   picker section, see ADIF_GROUPS
//                           status  ''          operator may add it
//                                   'builtin'   Noctalum already logs it in a dedicated field
//                                   'intl'      UTF-8 sibling, emitted automatically
//                                   'deprecated' import-only per the spec
//                           intl    name of the UTF-8 sibling, when the spec defines one
//                           replaces  what to use instead of a deprecated field
//   ADIF_FIELD_LABELS   — EN/DE labels, merged into the i18n catalogues as adifField.<TAG>
//   ADIF_GROUPS         — picker section order; labels live under adifGroup.<key> in i18n.js
`)
	b.WriteString("(() => {\n")
	fmt.Fprintf(&b, "  window.ADIF_SPEC_VERSION = %q;\n", version)

	// Group order is fixed here rather than derived from the catalogue so the
	// picker's sections stay in a deliberate reading order (what you worked,
	// then who you are, then contest/awards, then confirmations).
	b.WriteString("  window.ADIF_GROUPS = ['qso', 'contacted', 'mystation', 'contest', 'refs', 'prop', 'qsl', 'uploads'];\n")

	b.WriteString("  window.ADIF_FIELDS = [\n")
	for _, f := range fields {
		fmt.Fprintf(&b, "    { name: %q, input: %q, group: %q", f.Name, f.Input, f.Group)
		if f.Status != "" {
			fmt.Fprintf(&b, ", status: %q", f.Status)
		}
		if f.Intl != "" {
			fmt.Fprintf(&b, ", intl: %q", f.Intl)
		}
		if f.Replaces != "" {
			fmt.Fprintf(&b, ", replaces: %q", f.Replaces)
		}
		if len(f.Options) > 0 {
			b.WriteString(", options: [")
			for i, o := range f.Options {
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%q", o)
			}
			b.WriteString("]")
		}
		b.WriteString(" },\n")
	}
	b.WriteString("  ];\n")

	b.WriteString("  window.ADIF_FIELD_LABELS = {\n")
	for _, lang := range []string{"en", "de"} {
		fmt.Fprintf(&b, "    %s: {\n", lang)
		for _, f := range fields {
			l := f.LabelEN
			if lang == "de" {
				l = f.LabelDE
			}
			fmt.Fprintf(&b, "      %s: %q,\n", f.Name, l)
		}
		b.WriteString("    },\n")
	}
	b.WriteString("  };\n")
	b.WriteString("})();\n")
	return b.String()
}
