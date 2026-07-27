package wsjtx

import "testing"

// The web UI's encoder (internal/server/web/app.js encodeWsjtxToken) and
// this decoder must stay in lockstep — that pairing is the reason bridge
// tokens work at all. Regressions here silently break every existing user.
// The pinned string below was produced by the JS encoder for the payload
// {s:"https://log.example.org", t:"deadbeef", c:42, sc:"DM2LAP"}.
func TestDecodeKnownGoodToken(t *testing.T) {
	const blob = "noc1.eyJzIjoiaHR0cHM6Ly9sb2cuZXhhbXBsZS5vcmciLCJ0IjoiZGVhZGJlZWYiLCJjIjo0Miwic2MiOiJETTJMQVAifQ"
	tk, err := DecodeBridgeToken(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if tk.Server != "https://log.example.org" {
		t.Errorf("Server = %q", tk.Server)
	}
	if tk.HelperToken != "deadbeef" {
		t.Errorf("HelperToken = %q", tk.HelperToken)
	}
	if tk.ContestID != 42 {
		t.Errorf("ContestID = %d", tk.ContestID)
	}
	if tk.StationCall != "DM2LAP" {
		t.Errorf("StationCall = %q", tk.StationCall)
	}
}

// Round-trip check: Encode → Decode must reproduce every field so a UI
// that generates tokens from its own state doesn't drift from what the
// web UI produces.
func TestEncodeDecodeRoundTrip(t *testing.T) {
	in := BridgeToken{
		Server:      "https://example.com",
		HelperToken: "abc123",
		ContestID:   7,
		StationCall: "DL0XYZ",
	}
	out, err := DecodeBridgeToken(EncodeBridgeToken(in))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out != in {
		t.Errorf("round-trip differs: %+v vs %+v", out, in)
	}
}

// A bare host:port in the encoded server field must be normalised back to
// https:// on decode — matches the CLI/GUI bridges' historical default so
// pre-token config files that only carry a hostname keep working.
func TestDecodeAppliesHTTPSDefault(t *testing.T) {
	blob := EncodeBridgeToken(BridgeToken{
		Server: "log.example.org", HelperToken: "x", ContestID: 1,
	})
	tk, err := DecodeBridgeToken(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if tk.Server != "https://log.example.org" {
		t.Errorf("Server = %q, want https:// prefix", tk.Server)
	}
}

// Malformed inputs must reject cleanly — no panics, no partial data.
func TestDecodeRejectsGarbage(t *testing.T) {
	cases := []string{
		"",
		"noc1.",
		"noc2.abc",
		"not-a-token",
		"noc1.!!!not-base64!!!",
	}
	for _, in := range cases {
		if _, err := DecodeBridgeToken(in); err == nil {
			t.Errorf("expected error for %q", in)
		}
	}
}

// BaseCallsign must match the server's rule so the client-side MyCall
// filter and the server-side check agree on what "same station" means.
func TestBaseCallsign(t *testing.T) {
	cases := map[string]string{
		"DM2LAP":       "DM2LAP",
		"DM2LAP/P":     "DM2LAP",
		"F/DM2LAP":     "DM2LAP",
		"F/DM2LAP/P":   "DM2LAP",
		"":             "",
		"dm2lap":       "DM2LAP",
		"  DM2LAP  ":   "DM2LAP",
	}
	for in, want := range cases {
		if got := BaseCallsign(in); got != want {
			t.Errorf("BaseCallsign(%q) = %q, want %q", in, got, want)
		}
	}
}
