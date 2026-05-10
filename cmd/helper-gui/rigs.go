package main

// RigPreset is one entry in the curated list the auto-probe walks through.
// The same list feeds the manual configuration dropdown so the operator can
// pick a model by name instead of remembering the Hamlib model number.
type RigPreset struct {
	Label        string `json:"label"`
	Model        int    `json:"model"`
	DefaultSpeed int    `json:"default_speed"`
	Vendor       string `json:"vendor"`
}

// curatedRigs is intentionally small: the auto-probe walks every entry, so
// each addition costs ~2 s on the first pass.  The list covers the rigs
// most contest stations actually own; everything else falls back to the
// manual configuration form.
var curatedRigs = []RigPreset{
	// Icom — CI-V; default 19200 on modern rigs, 9600 on older ones.
	{Label: "IC-7300", Model: 3073, DefaultSpeed: 19200, Vendor: "Icom"},
	{Label: "IC-705", Model: 3085, DefaultSpeed: 9600, Vendor: "Icom"},
	{Label: "IC-9700", Model: 3081, DefaultSpeed: 19200, Vendor: "Icom"},
	{Label: "IC-7100", Model: 3061, DefaultSpeed: 9600, Vendor: "Icom"},
	{Label: "IC-7610", Model: 3068, DefaultSpeed: 19200, Vendor: "Icom"},
	{Label: "IC-7200", Model: 3062, DefaultSpeed: 19200, Vendor: "Icom"},
	{Label: "IC-7000", Model: 3071, DefaultSpeed: 19200, Vendor: "Icom"},

	// Yaesu — CAT; defaults vary, 38400 on the modern ones.
	{Label: "FT-991/A", Model: 1040, DefaultSpeed: 38400, Vendor: "Yaesu"},
	{Label: "FT-DX10", Model: 1042, DefaultSpeed: 38400, Vendor: "Yaesu"},
	{Label: "FTdx101D/MP", Model: 1041, DefaultSpeed: 38400, Vendor: "Yaesu"},
	{Label: "FT-450/D", Model: 1039, DefaultSpeed: 4800, Vendor: "Yaesu"},
	{Label: "FT-857", Model: 1018, DefaultSpeed: 4800, Vendor: "Yaesu"},
	{Label: "FT-897", Model: 1020, DefaultSpeed: 4800, Vendor: "Yaesu"},

	// Kenwood — TS-series.
	{Label: "TS-590S", Model: 2014, DefaultSpeed: 9600, Vendor: "Kenwood"},
	{Label: "TS-590SG", Model: 2027, DefaultSpeed: 9600, Vendor: "Kenwood"},
	{Label: "TS-890S", Model: 2028, DefaultSpeed: 115200, Vendor: "Kenwood"},
	{Label: "TS-2000", Model: 2042, DefaultSpeed: 9600, Vendor: "Kenwood"},
}

// probeBauds is the order tried during the "Testing baud rate" phase.  We
// walk highest-to-lowest because faster is better and most rigs that work
// at 38400 also work at 9600 — picking the slower-but-working speed would
// leave performance on the table.
var probeBauds = []int{115200, 57600, 38400, 19200, 9600, 4800}

// rigByModel returns the curated label for a model number, or empty when
// the user picked a custom (non-curated) model.
func rigByModel(model int) string {
	for _, r := range curatedRigs {
		if r.Model == model {
			return r.Label
		}
	}
	return ""
}
