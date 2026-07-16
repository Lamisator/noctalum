package store

import (
	"strings"
	"unicode/utf8"
)

// cleanStr returns s with any invalid UTF-8 sequences dropped and any
// embedded NUL bytes removed. Fast-path returns the input untouched
// when it's already valid so the common case allocates nothing.
//
// This is the same helper cmd/sqlite-to-pg uses to sanitise legacy
// SQLite rows. It's also needed at runtime because Postgres rejects
// non-UTF-8 payloads with SQLSTATE 22021 and drops the whole INSERT,
// whereas SQLite silently stored whatever bytes it was handed.
//
// Applied at storage boundaries where external systems feed us text
// we don't control the encoding of — most notably the DX-cluster
// feed, whose European spotters occasionally send Latin-1-encoded
// comments (e.g. "6ème étape du Tour de France" with a 0xE8 byte
// where UTF-8 wants 0xC3 0xA9). Without this filter the spot silently
// fails to save instead of appearing in the frontend.
func cleanStr(s string) string {
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		return s
	}
	s = strings.ToValidUTF8(s, "")
	return strings.ReplaceAll(s, "\x00", "")
}
