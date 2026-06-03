package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
	"github.com/noctalum/noctalum/internal/store"
)

// natural column widths in mm; values picked to fit the typical content.
var pdfColWidth = map[string]float64{
	"nr_sent":      10,
	"nr_received":  12,
	"time":         28,
	"callsign":     22,
	"band":         12,
	"freq":         16,
	"mode":         12,
	"rst_sent":     11,
	"rst_received": 11,
	"name":         22,
	"locator":      14,
	"itu":          14,
	"dok":          12,
	"lighthouse":   20,
	"notes":        35,
	"operator":     18,
}

const pdfDefaultColWidth = 18.0

// ExportPDF writes a styled PDF report of the contest log to w.
//
// cols is the ordered list of columns to render. logoPNG, when non-nil, is
// rendered as the small logo on the top-left of the header. mapImagePNG, when
// non-nil, appends an extra page with a 2D map of all QSOs; mapPageTitle is
// the heading shown on that page.
func ExportPDF(w io.Writer, qsos []store.QSO, cols []LogColumn, contestName, stationCall, qth string, logoPNG []byte, programVersion, freqUnit string, mapImagePNG []byte, mapPageTitle string) error {
	pdf := gofpdf.New("L", "mm", "A4", "")
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(true, 14)
	// Helvetica is encoded in cp1252; UTF-8 input has to be translated so Ø,
	// ·, ä, etc. render correctly instead of as mojibake.
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	s := func(text string) string { return tr(sanitize(text)) }

	// Page-width usable area.
	pageW, _ := pdf.GetPageSize()
	leftMargin, _, rightMargin, _ := pdf.GetMargins()
	usableW := pageW - leftMargin - rightMargin

	// Embed logo image once (gofpdf de-duplicates by name).
	const logoName = "noctalum_logo"
	if len(logoPNG) > 0 {
		opt := gofpdf.ImageOptions{ImageType: "PNG", ReadDpi: false}
		pdf.RegisterImageOptionsReader(logoName, opt, bytes.NewReader(logoPNG))
	}

	// Compute column widths so they sum exactly to usableW.
	widths := make([]float64, len(cols))
	var natural float64
	for i, c := range cols {
		w, ok := pdfColWidth[c.Key]
		if !ok {
			w = pdfDefaultColWidth
		}
		widths[i] = w
		natural += w
	}
	if natural > 0 {
		scale := usableW / natural
		for i := range widths {
			widths[i] *= scale
		}
	}

	// Header rendering — called by AddPage so it repeats on every page.
	drawHeader := func() {
		// Logo on the left.
		const logoH = 20.0
		const logoW = 20.0
		if len(logoPNG) > 0 {
			pdf.ImageOptions(logoName, leftMargin, 8, logoW, logoH, false, gofpdf.ImageOptions{ImageType: "PNG"}, 0, "")
		}
		// Title block to the right of the logo.
		textX := leftMargin + logoW + 4
		pdf.SetXY(textX, 9)
		pdf.SetTextColor(20, 20, 30)
		pdf.SetFont("Helvetica", "B", 18)
		pdf.CellFormat(usableW-logoW-4, 8, "Noctalum", "", 1, "L", false, 0, "")
		pdf.SetX(textX)
		pdf.SetFont("Helvetica", "", 11)
		pdf.SetTextColor(60, 60, 70)
		pdf.CellFormat(usableW-logoW-4, 5, "Contest log report", "", 1, "L", false, 0, "")
		// Contest meta on the right side of the header.
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetTextColor(30, 30, 40)
		metaW := 90.0
		metaX := pageW - rightMargin - metaW
		pdf.SetXY(metaX, 9)
		pdf.CellFormat(metaW, 5, s(contestName), "", 2, "R", false, 0, "")
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(60, 60, 70)
		stationLine := stationCall
		if qth != "" {
			stationLine = stationCall + "  " + qth
		}
		pdf.SetX(metaX)
		pdf.CellFormat(metaW, 4.5, s(stationLine), "", 2, "R", false, 0, "")
		pdf.SetX(metaX)
		pdf.CellFormat(metaW, 4.5, s(fmt.Sprintf("%d QSOs · generated %s UTC", len(qsos), time.Now().UTC().Format("2006-01-02 15:04"))), "", 2, "R", false, 0, "")

		// Accent line under the header.
		pdf.SetDrawColor(40, 90, 170)
		pdf.SetLineWidth(0.6)
		pdf.Line(leftMargin, 32, pageW-rightMargin, 32)
		pdf.SetLineWidth(0.2)

		pdf.SetY(34)
		// Table header row.
		pdf.SetFont("Helvetica", "B", 8.5)
		pdf.SetFillColor(40, 90, 170)
		pdf.SetTextColor(255, 255, 255)
		pdf.SetDrawColor(40, 90, 170)
		for i, c := range cols {
			pdf.CellFormat(widths[i], 7, s(c.Label), "1", 0, "L", true, 0, "")
		}
		pdf.Ln(-1)
		pdf.SetFont("Helvetica", "", 8)
		pdf.SetTextColor(20, 20, 30)
		pdf.SetDrawColor(220, 220, 230)
	}

	pdf.SetHeaderFunc(drawHeader)

	// Footer with page numbers + program version.
	pdf.SetFooterFunc(func() {
		pdf.SetY(-10)
		pdf.SetFont("Helvetica", "I", 8)
		pdf.SetTextColor(120, 120, 130)
		pdf.CellFormat(usableW/2, 5, "Noctalum v"+programVersion, "", 0, "L", false, 0, "")
		pdf.CellFormat(usableW/2, 5, fmt.Sprintf("Page %d / {nb}", pdf.PageNo()), "", 0, "R", false, 0, "")
	})
	pdf.AliasNbPages("")

	pdf.AddPage()

	// Body rows. Each row's height grows to fit the tallest wrapped cell, so
	// long values like Notes get full multi-line layout instead of being
	// truncated mid-glyph by the right border.
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(20, 20, 30)
	pdf.SetDrawColor(220, 220, 230)
	pdf.SetLineWidth(0.2)
	const lineH = 4.2
	_, pageH := pdf.GetPageSize()
	_, _, _, bottomMargin := pdf.GetMargins()
	pageBreakY := pageH - bottomMargin

	for i, q := range qsos {
		extras := parseExtras(q.Extras)
		// Pre-translate + split each cell into wrapped lines so we can size
		// the row to the tallest one. Empty cells still occupy one line so
		// the row has at least the standard height.
		cellLines := make([][]string, len(cols))
		maxLines := 1
		for j, c := range cols {
			translated := s(qsoColValuePDF(q, c.Key, extras, freqUnit))
			if translated == "" {
				cellLines[j] = []string{""}
				continue
			}
			rawLines := pdf.SplitLines([]byte(translated), widths[j])
			lines := make([]string, len(rawLines))
			for k, b := range rawLines {
				lines[k] = string(b)
			}
			if len(lines) == 0 {
				lines = []string{""}
			}
			cellLines[j] = lines
			if len(lines) > maxLines {
				maxLines = len(lines)
			}
		}
		rowH := float64(maxLines) * lineH

		// Manual page break — auto-break can't help us because we draw cell
		// borders ourselves and don't call CellFormat for the whole row.
		if pdf.GetY()+rowH > pageBreakY {
			pdf.AddPage()
		}

		if i%2 == 1 {
			pdf.SetFillColor(245, 246, 250)
		} else {
			pdf.SetFillColor(255, 255, 255)
		}
		startY := pdf.GetY()
		x := leftMargin
		for j, c := range cols {
			align := alignFor(c.Key)
			// Background fill first (drawn for the full row height so short
			// cells stay zebra-coloured next to a tall neighbour).
			pdf.Rect(x, startY, widths[j], rowH, "F")
			// Text lines.
			for k, ln := range cellLines[j] {
				pdf.SetXY(x, startY+float64(k)*lineH)
				pdf.CellFormat(widths[j], lineH, ln, "", 0, align, false, 0, "")
			}
			// Left + right cell borders.
			pdf.Line(x, startY, x, startY+rowH)
			pdf.Line(x+widths[j], startY, x+widths[j], startY+rowH)
			x += widths[j]
		}
		pdf.SetXY(leftMargin, startY+rowH)
	}
	// Close out the bottom border.
	pdf.SetDrawColor(220, 220, 230)
	pdf.SetLineWidth(0.2)
	y := pdf.GetY()
	pdf.Line(leftMargin, y, pageW-rightMargin, y)

	if len(mapImagePNG) > 0 {
		// Switch to a plain header (logo + title only, no table columns) for the
		// map page.
		pdf.SetHeaderFunc(func() {
			if len(logoPNG) > 0 {
				pdf.ImageOptions(logoName, leftMargin, 8, 20, 20, false, gofpdf.ImageOptions{ImageType: "PNG"}, 0, "")
			}
			textX := leftMargin + 24
			pdf.SetXY(textX, 9)
			pdf.SetFont("Helvetica", "B", 18)
			pdf.SetTextColor(20, 20, 30)
			pdf.CellFormat(usableW-24, 8, "Noctalum", "", 1, "L", false, 0, "")
			pdf.SetX(textX)
			pdf.SetFont("Helvetica", "", 11)
			pdf.SetTextColor(60, 60, 70)
			pdf.CellFormat(usableW-24, 5, "Contest log report", "", 1, "L", false, 0, "")
			pdf.SetDrawColor(40, 90, 170)
			pdf.SetLineWidth(0.6)
			pdf.Line(leftMargin, 32, pageW-rightMargin, 32)
			pdf.SetLineWidth(0.2)
			pdf.SetY(36)
		})
		pdf.AddPage()

		pdf.SetFont("Helvetica", "B", 13)
		pdf.SetTextColor(30, 30, 40)
		pdf.CellFormat(usableW, 7, s(mapPageTitle), "", 1, "L", false, 0, "")
		pdf.Ln(2)

		imgY := pdf.GetY()
		imgH := pageH - imgY - bottomMargin - 2
		const mapImgName = "noctalum_map_image"
		pdf.RegisterImageOptionsReader(mapImgName, gofpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(mapImagePNG))
		pdf.ImageOptions(mapImgName, leftMargin, imgY, usableW, imgH, false, gofpdf.ImageOptions{ImageType: "PNG"}, 0, "")
	}

	return pdf.Output(w)
}

func alignFor(key string) string {
	switch key {
	case "nr_sent", "nr_received", "freq", "rst_sent", "rst_received":
		return "R"
	case "band", "mode", "itu":
		return "C"
	}
	return "L"
}

func qsoColValuePDF(q store.QSO, key string, extras map[string]string, freqUnit string) string {
	switch key {
	case "nr_sent":
		if q.NrSent > 0 {
			return fmt.Sprintf("%d", q.NrSent)
		}
		return ""
	case "nr_received":
		if q.NrReceived > 0 {
			return fmt.Sprintf("%d", q.NrReceived)
		}
		return ""
	case "time":
		return q.Time.UTC().Format("2006-01-02 15:04:05")
	case "callsign":
		return strings.ReplaceAll(strings.ToUpper(q.Callsign), "0", "Ø")
	case "band":
		return formatBand(q.Band)
	case "freq":
		if q.FreqHz > 0 {
			switch freqUnit {
			case "Hz":
				return fmt.Sprintf("%d", q.FreqHz)
			case "MHz":
				return fmt.Sprintf("%.6f", float64(q.FreqHz)/1_000_000.0)
			case "GHz":
				return fmt.Sprintf("%.9f", float64(q.FreqHz)/1_000_000_000.0)
			default: // kHz
				return fmt.Sprintf("%.3f", float64(q.FreqHz)/1_000.0)
			}
		}
		return ""
	case "mode":
		return q.Mode
	case "rst_sent":
		return q.RSTSent
	case "rst_received":
		return q.RSTReceived
	case "name":
		return q.Name
	case "locator":
		return strings.ToUpper(q.Locator)
	case "itu":
		if q.ITUZone == "" && q.CQZone == "" {
			return ""
		}
		a := q.ITUZone
		if a == "" {
			a = "-"
		}
		b := q.CQZone
		if b == "" {
			b = "-"
		}
		return a + "/" + b
	case "dok":
		return strings.ToUpper(q.DOK)
	case "lighthouse":
		return q.Lighthouse
	case "notes":
		return q.Notes
	case "operator":
		return strings.ReplaceAll(strings.ToUpper(q.Operator), "0", "Ø")
	}
	if v, ok := extras[key]; ok {
		return v
	}
	return ""
}

func formatBand(b string) string {
	// Insert a space before "cm" or "m" suffix on a numeric prefix: "20m" → "20 m".
	for i, r := range b {
		if r < '0' || r > '9' {
			if i > 0 {
				return b[:i] + " " + b[i:]
			}
			return b
		}
	}
	return b
}

// sanitize strips control characters (other than tabs/newlines which become
// spaces) so they cannot land in the PDF stream. The cp1252 translator
// applied afterwards handles any character outside its mapping.
func sanitize(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			b.WriteRune(' ')
			continue
		}
		if r < 0x20 {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func parseExtras(raw string) map[string]string {
	out := map[string]string{}
	if raw == "" {
		return out
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return out
	}
	for k, v := range m {
		switch t := v.(type) {
		case string:
			out[k] = t
		case bool:
			if t {
				out[k] = "yes"
			} else {
				out[k] = "no"
			}
		case float64:
			out[k] = strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.4f", t), "0"), ".")
		case nil:
			out[k] = ""
		default:
			out[k] = fmt.Sprintf("%v", t)
		}
	}
	return out
}
