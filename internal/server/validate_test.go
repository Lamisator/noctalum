package server

import "testing"

func TestValidCallsignAcceptsSlashes(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"DM2LAP", true},
		{"G0ABC", true},
		{"4U1WB", true},
		{"DM2LAP/P", true},
		{"DM2LAP/MM", true},
		{"DM2LAP/QRP", true},
		{"F/DM2LAP", true},
		{"OE/DJ3KA", true},
		{"F/DM2LAP/P", true},
		{"VK4/G0ABC/M", true},
		{"", false},
		{"/", false},
		{"/DM2LAP", false},
		{"DM2LAP/", false},
		{"DM", false},
		{"F/F", false},
		{"DM2LAP/!!", false},
	}
	for _, c := range cases {
		if got := ValidCallsign(c.in); got != c.want {
			t.Errorf("ValidCallsign(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestBaseCallsignStripsPrefixAndSuffix(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"DM2LAP", "DM2LAP"},
		{"dm2lap", "DM2LAP"},
		{"F/DM2LAP", "DM2LAP"},
		{"DM2LAP/P", "DM2LAP"},
		{"DM2LAP/MM", "DM2LAP"},
		{"F/DM2LAP/P", "DM2LAP"},
		{"OE/DJ3KA", "DJ3KA"},
		{"VK4/G0ABC/M", "G0ABC"},
		{"K1AB/4", "K1AB"},
		{"", ""},
	}
	for _, c := range cases {
		if got := BaseCallsign(c.in); got != c.want {
			t.Errorf("BaseCallsign(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
