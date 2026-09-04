package server

import (
	"testing"

	"github.com/noctalum/noctalum/internal/store"
)

func TestClassifyLogLine(t *testing.T) {
	cases := []struct {
		in      string
		wantLvl store.SysLevel
		wantSrc string
		wantMsg string
	}{
		// Bare Noctalum-style prefix.
		{"cluster: connected to dxc.ve7cc.net", store.SysInfo, "cluster", "connected to dxc.ve7cc.net"},
		// Multi-word prefix ("shutdown trigger").
		{"shutdown trigger: cleared stale trigger file at startup", store.SysInfo, "shutdown trigger", "cleared stale trigger file at startup"},
		// "warning:" mid-line → warn.
		{"cluster: warning: read timeout", store.SysWarn, "cluster", "warning: read timeout"},
		// "failed" → error.
		{"backup: automatic take failed: pg_dump exit 1", store.SysError, "backup", "automatic take failed: pg_dump exit 1"},
		// No prefix at all → generic "log" source.
		{"Noctalum listening on :8080", store.SysInfo, "log", "Noctalum listening on :8080"},
		// Timestamp prefix from a caller that turned on log.LstdFlags — should be stripped.
		{"2026/08/15 12:34:56 cluster: read error: EOF", store.SysError, "cluster", "read error: EOF"},
	}
	for _, tc := range cases {
		gotLvl, gotSrc, gotMsg := classifyLogLine(tc.in)
		if gotLvl != tc.wantLvl || gotSrc != tc.wantSrc || gotMsg != tc.wantMsg {
			t.Errorf("classifyLogLine(%q) = (%q, %q, %q); want (%q, %q, %q)",
				tc.in, gotLvl, gotSrc, gotMsg, tc.wantLvl, tc.wantSrc, tc.wantMsg)
		}
	}
}
