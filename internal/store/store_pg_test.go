package store_test

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/noctalum/noctalum/internal/store"
)

// openScratchDB returns a Store connected to a fresh, uniquely-named
// database that the test can pollute freely. Requires
// NOCTALUM_TEST_DATABASE_URL to point at a Postgres role with CREATEDB
// privilege (e.g. postgres://noctalum:noctalum@localhost:5432/postgres).
// If the env var is unset, the test is skipped so this file doesn't break
// CI environments without a live Postgres.
func openScratchDB(t *testing.T) *store.Store {
	t.Helper()
	adminDSN := os.Getenv("NOCTALUM_TEST_DATABASE_URL")
	if adminDSN == "" {
		t.Skip("NOCTALUM_TEST_DATABASE_URL not set; skipping Postgres integration test")
	}
	admin, err := sql.Open("pgx", adminDSN)
	if err != nil {
		t.Fatalf("open admin db: %v", err)
	}
	name := fmt.Sprintf("noctalum_it_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		admin.Close()
		t.Fatalf("create scratch db: %v", err)
	}
	admin.Close()

	// Derive the scratch DSN by swapping the database name in the DSN
	// path. Works for both URL-form and libpq-form DSNs (the latter would
	// need a different substitution — we only handle URL form here since
	// that's what CI and the deploy stack use).
	scratchDSN := swapDBName(adminDSN, name)
	st, err := store.Open(scratchDSN)
	if err != nil {
		t.Fatalf("open scratch store: %v", err)
	}

	t.Cleanup(func() {
		_ = st.Close()
		admin, err := sql.Open("pgx", adminDSN)
		if err != nil {
			return
		}
		defer admin.Close()
		// FORCE terminates any lingering connections so the DROP succeeds
		// even if some background goroutine is still holding a session.
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
	})
	return st
}

// swapDBName replaces the database name in a postgres:// URL. Assumes the
// URL is in URL form (postgres://user:pass@host[:port]/dbname?params) —
// which matches what NOCTALUM_TEST_DATABASE_URL is expected to hold.
func swapDBName(dsn, newName string) string {
	q := ""
	if i := strings.IndexByte(dsn, '?'); i >= 0 {
		q = dsn[i:]
		dsn = dsn[:i]
	}
	// Strip everything from the last "/" onwards (the old database name)
	// then append the new one.
	i := strings.LastIndexByte(dsn, '/')
	if i < 0 {
		return dsn + "/" + newName + q
	}
	return dsn[:i+1] + newName + q
}

// TestPostgresSchemaAndRoundTrips exercises every store subsystem against a
// real Postgres to catch dialect regressions the unit tests can't see.
// Rows are asserted end-to-end (insert → scan) so any type-mapping or
// placeholder mistake surfaces immediately.
func TestPostgresSchemaAndRoundTrips(t *testing.T) {
	st := openScratchDB(t)

	if err := st.EnsureBuiltinRoles([]string{"feature_requests.submit"}); err != nil {
		t.Fatalf("ensure roles: %v", err)
	}

	// Users + roles + unique-violation error mapping.
	u, err := st.CreateUser("alice", "DL0TEST", "supersecret1234", []string{"admin", "user"})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if u.ID == 0 {
		t.Fatal("expected non-zero user id from RETURNING")
	}
	if _, err := st.CreateUser("alice", "X", "otherpassword", nil); !errors.Is(err, store.ErrUsernameTaken) {
		t.Fatalf("duplicate CreateUser should return ErrUsernameTaken, got %v", err)
	}

	// Contests + access + participants — both ON CONFLICT DO NOTHING paths.
	c, err := st.CreateContest("Test Contest", "DL0TEST", "JN49XX", []string{"20m", "40m"}, "obj", "OP1", store.VisibilityOpen, u.ID, "", "", "", "", "", true, 60, "kHz", nil, nil)
	if err != nil {
		t.Fatalf("create contest: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := st.GrantContestAccess(c.ID, u.ID); err != nil {
			t.Fatalf("grant access (call %d): %v", i, err)
		}
		if err := st.AddContestParticipant(c.ID, u.ID, "owner", "active"); err != nil {
			t.Fatalf("add participant (call %d): %v", i, err)
		}
	}
	if _, err := st.CreateContest("Test Contest", "X", "", nil, "", "", store.VisibilityOpen, u.ID, "", "", "", "", "", true, 60, "kHz", nil, nil); err == nil {
		t.Fatal("duplicate contest name should fail")
	}

	// QSOs — insert, list, get, update, delete.
	now := time.Now().UTC().Truncate(time.Second)
	q := &store.QSO{
		ContestID: c.ID, Time: now, Callsign: "dl8aa", Name: "Jörg",
		Band: "40m", FreqHz: 7050000, Mode: "SSB",
		RSTSent: "59", RSTReceived: "59", NrSent: 1, NrReceived: 2,
		Operator: "dm2lap", StationCall: "dm2lap", Notes: "hi",
	}
	id, err := st.InsertQSO(q)
	if err != nil {
		t.Fatalf("insert qso: %v", err)
	}
	got, err := st.GetQSO(id)
	if err != nil {
		t.Fatalf("get qso: %v", err)
	}
	if got.Callsign != "DL8AA" {
		t.Errorf("callsign should be uppercased on insert; got %q", got.Callsign)
	}
	if !got.Time.Equal(now) {
		t.Errorf("time round-trip mismatch: want %v got %v", now, got.Time)
	}
	if got.Name != "Jörg" {
		t.Errorf("umlaut lost in name round-trip: %q", got.Name)
	}

	// Duplicate detection uses the composite index + time window.
	dup, err := st.FindDuplicate(c.ID, "dl8aa", "40m", "SSB", time.Hour)
	if err != nil || !dup {
		t.Fatalf("expected duplicate to be found, got dup=%v err=%v", dup, err)
	}

	// Sessions — round-trip an upsert.
	sess := store.SessionRow{ID: "sess-1", UserID: u.ID, CSRFToken: "a", CreatedAt: now, LastSeen: now, ExpiresAt: now.Add(time.Hour)}
	if err := st.SaveSession(sess); err != nil {
		t.Fatalf("save session: %v", err)
	}
	sess.CSRFToken = "b"
	if err := st.SaveSession(sess); err != nil {
		t.Fatalf("re-save session (upsert): %v", err)
	}
	rows, err := st.LoadSessions()
	if err != nil || len(rows) != 1 || rows[0].CSRFToken != "b" {
		t.Fatalf("session upsert did not update: rows=%+v err=%v", rows, err)
	}

	// Callsign cache upsert.
	if err := st.UpsertCallsignDOK("dl8aa", "h01"); err != nil {
		t.Fatalf("upsert cache: %v", err)
	}
	if err := st.UpsertCallsignDOK("dl8aa", "h02"); err != nil {
		t.Fatalf("re-upsert cache: %v", err)
	}
	if dok := st.GetCachedDOK("DL8AA"); dok != "H02" {
		t.Errorf("cache upsert did not update dok; got %q", dok)
	}

	// Cluster spot prune (make_interval semantics).
	if err := st.SaveClusterSpot(store.ClusterSpot{Time: "12:00Z", DX: "DL8AA", Freq: "7050", Band: "40m", Mode: "SSB"}); err != nil {
		t.Fatalf("save spot: %v", err)
	}
	if err := st.PruneClusterSpots(30); err != nil {
		t.Fatalf("prune spots (30d): %v", err)
	}
	spots, _ := st.LoadRecentClusterSpots(5)
	if len(spots) != 1 {
		t.Errorf("expected 1 spot after prune with 30d retention; got %d", len(spots))
	}
	// Prune with 0 days should wipe every non-future row.
	if err := st.PruneClusterSpots(0); err != nil {
		t.Fatalf("prune spots (0d): %v", err)
	}
	spots, _ = st.LoadRecentClusterSpots(5)
	if len(spots) != 0 {
		t.Errorf("expected 0 spots after 0d prune; got %d", len(spots))
	}

	// Audit log filter builder (LIKE → ILIKE + positional placeholders).
	if err := st.InsertAuditLog(store.AuditInfo, "login", "alice", "127.0.0.1", "welcome", "127.0.0.1"); err != nil {
		t.Fatalf("audit insert: %v", err)
	}
	entries, total, err := st.ListAuditLogs(store.AuditFilter{Search: "welcome", Limit: 10})
	if err != nil {
		t.Fatalf("audit filter: %v", err)
	}
	if total != 1 || len(entries) != 1 || entries[0].Action != "login" {
		t.Errorf("audit filter mismatch: total=%d entries=%+v", total, entries)
	}

	// Feature request insert + list.
	fr, err := st.InsertFeatureRequest("alice", "test")
	if err != nil {
		t.Fatalf("fr insert: %v", err)
	}
	frs, err := st.ListFeatureRequestsByUser("alice")
	if err != nil || len(frs) != 1 || frs[0].ID != fr.ID {
		t.Fatalf("fr list mismatch: err=%v frs=%+v", err, frs)
	}
	// Insert a second request with two attachments and confirm both come
	// back on the parent, in insert order, via GetFeatureRequest.
	fr2, err := st.InsertFeatureRequest("alice", "with attachments")
	if err != nil {
		t.Fatalf("fr insert with attachments: %v", err)
	}
	if _, err := st.InsertFeatureRequestAttachment(fr2.ID, "abc123.pdf", "spec.pdf", "application/pdf", 42); err != nil {
		t.Fatalf("fr attachment #1: %v", err)
	}
	if _, err := st.InsertFeatureRequestAttachment(fr2.ID, "def456.png", "screenshot.png", "image/png", 4096); err != nil {
		t.Fatalf("fr attachment #2: %v", err)
	}
	gotFR, err := st.GetFeatureRequest(fr2.ID)
	if err != nil || gotFR == nil {
		t.Fatalf("fr get: err=%v got=%+v", err, gotFR)
	}
	if len(gotFR.Attachments) != 2 {
		t.Fatalf("expected 2 attachments, got %d: %+v", len(gotFR.Attachments), gotFR.Attachments)
	}
	if gotFR.Attachments[0].Filename != "abc123.pdf" || gotFR.Attachments[0].OriginalName != "spec.pdf" ||
		gotFR.Attachments[0].Mime != "application/pdf" || gotFR.Attachments[0].Size != 42 {
		t.Fatalf("attachment #1 mismatch: %+v", gotFR.Attachments[0])
	}
	if gotFR.Attachments[1].Filename != "def456.png" || gotFR.Attachments[1].OriginalName != "screenshot.png" ||
		gotFR.Attachments[1].Mime != "image/png" || gotFR.Attachments[1].Size != 4096 {
		t.Fatalf("attachment #2 mismatch: %+v", gotFR.Attachments[1])
	}

	// DeleteQSO cleanup.
	if err := st.DeleteQSO(id); err != nil {
		t.Fatalf("delete qso: %v", err)
	}
	if _, err := st.GetQSO(id); err == nil {
		t.Error("expected deleted QSO to be missing")
	}
}

// Regression: DX-cluster spots occasionally arrive as Latin-1
// (European operators typing accented characters into a byte-oriented
// AR-cluster client). SQLite silently stored the bad bytes; Postgres
// rejects them with SQLSTATE 22021 and would drop the whole INSERT.
// SaveClusterSpot now sanitises through cleanStr() so the spot lands
// in the DB with the invalid bytes stripped, instead of vanishing.
func TestSaveClusterSpotSanitisesInvalidUTF8(t *testing.T) {
	st := openScratchDB(t)

	// "6ème étape" mis-encoded as Latin-1: byte 0xE8 stands for 'è'
	// in Latin-1 but is not a valid UTF-8 start byte.
	badComment := "6\xe8me \xe9tape"
	sp := store.ClusterSpot{
		Time: "12:00Z", DX: "F8GGZ", Freq: "14150.0",
		Band: "20m", Mode: "SSB", Comment: badComment, Spotter: "DL0X",
	}
	if err := st.SaveClusterSpot(sp); err != nil {
		t.Fatalf("SaveClusterSpot rejected Latin-1 bytes — sanitiser not applied? %v", err)
	}
	spots, err := st.LoadRecentClusterSpots(1)
	if err != nil || len(spots) != 1 {
		t.Fatalf("expected 1 spot back, got %d (%v)", len(spots), err)
	}
	// The 0xE8 and 0xE9 bytes should have been stripped; what
	// remains is a valid UTF-8 string. We don't require any
	// particular replacement — just that it round-trips and
	// contains none of the offending bytes.
	got := spots[0].Comment
	for i := 0; i < len(got); i++ {
		if got[i] == 0xE8 || got[i] == 0xE9 {
			t.Errorf("invalid Latin-1 byte still present in stored comment: %q", got)
			break
		}
	}
}

// TestContestTemplates covers the contest-template CRUD end-to-end: the
// built-in seed, per-owner (not global) name uniqueness, the visibility rule
// that ListContestTemplates implements, and the update/delete paths.
func TestContestTemplates(t *testing.T) {
	st := openScratchDB(t)

	if err := st.EnsureBuiltinRoles(nil); err != nil {
		t.Fatalf("ensure roles: %v", err)
	}
	alice, err := st.CreateUser("alice", "DL0AAA", "supersecret1234", []string{"user"})
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	bob, err := st.CreateUser("bob", "DL0BBB", "supersecret1234", []string{"user"})
	if err != nil {
		t.Fatalf("create bob: %v", err)
	}

	// The migration seeds the built-in EU DX template as a shared, ownerless
	// row so upgrades keep the preset the create dialog used to hardcode.
	seeded, err := st.ListContestTemplates(alice.ID)
	if err != nil {
		t.Fatalf("list seeded: %v", err)
	}
	if len(seeded) != 1 || seeded[0].Name != "EU DX Contest" || !seeded[0].Shared || seeded[0].OwnerUserID != 0 {
		t.Fatalf("expected one shared built-in template, got %+v", seeded)
	}

	// A personal template is visible to its owner only.
	priv, err := st.CreateContestTemplate(&store.ContestTemplate{
		Name:         "Alice private",
		DefaultName:  "Field Day",
		Bands:        []string{"20m", "40m"},
		CustomFields: `[{"name":"class","label":"Class","type":"text","required":true,"options":[],"order":0}]`,
		FreqUnit:     "MHz",
	}, alice.ID)
	if err != nil {
		t.Fatalf("create private template: %v", err)
	}
	if priv.StashExpiryMinutes != 60 {
		t.Errorf("stash expiry should default to 60, got %d", priv.StashExpiryMinutes)
	}

	aliceList, err := st.ListContestTemplates(alice.ID)
	if err != nil {
		t.Fatalf("list for alice: %v", err)
	}
	if len(aliceList) != 2 {
		t.Fatalf("alice should see her own + the shared built-in, got %d", len(aliceList))
	}
	if aliceList[0].MyRole != "owner" {
		t.Errorf("alice's own template should sort first and be flagged owner, got %+v", aliceList[0])
	}
	bobList, err := st.ListContestTemplates(bob.ID)
	if err != nil {
		t.Fatalf("list for bob: %v", err)
	}
	if len(bobList) != 1 || bobList[0].OwnerUserID != 0 {
		t.Fatalf("bob must not see alice's unshared template, got %+v", bobList)
	}

	// Names are unique per owner, not globally: bob may reuse alice's name.
	if _, err := st.CreateContestTemplate(&store.ContestTemplate{Name: "Alice private"}, alice.ID); !errors.Is(err, store.ErrTemplateNameTaken) {
		t.Fatalf("same owner + same name should be rejected, got %v", err)
	}
	if _, err := st.CreateContestTemplate(&store.ContestTemplate{Name: "Alice private"}, bob.ID); err != nil {
		t.Fatalf("different owner should be allowed to reuse a name: %v", err)
	}

	// Sharing makes it visible to everyone; the round-trip preserves the
	// JSON blobs and the band list untouched.
	priv.Shared = true
	priv.Bands = []string{"15m"}
	if err := st.UpdateContestTemplate(priv.ID, priv); err != nil {
		t.Fatalf("update template: %v", err)
	}
	got, err := st.GetContestTemplate(priv.ID)
	if err != nil {
		t.Fatalf("get template: %v", err)
	}
	if !got.Shared || len(got.Bands) != 1 || got.Bands[0] != "15m" || got.FreqUnit != "MHz" {
		t.Fatalf("update did not round-trip: %+v", got)
	}
	if !strings.Contains(got.CustomFields, `"class"`) {
		t.Errorf("custom_fields blob lost in round-trip: %q", got.CustomFields)
	}
	bobList, err = st.ListContestTemplates(bob.ID)
	if err != nil {
		t.Fatalf("re-list for bob: %v", err)
	}
	if len(bobList) != 3 {
		t.Fatalf("bob should now see 3 templates (his own + 2 shared), got %d", len(bobList))
	}

	// An empty freq unit falls back to kHz rather than writing a value the
	// frontend can't render.
	got.FreqUnit = ""
	if err := st.UpdateContestTemplate(got.ID, got); err != nil {
		t.Fatalf("update with empty freq unit: %v", err)
	}
	again, err := st.GetContestTemplate(got.ID)
	if err != nil {
		t.Fatalf("re-get: %v", err)
	}
	if again.FreqUnit != "kHz" {
		t.Errorf("empty freq unit should normalise to kHz, got %q", again.FreqUnit)
	}

	// Delete is idempotent from the caller's point of view: the second call
	// reports ErrTemplateNotFound rather than silently succeeding.
	if err := st.DeleteContestTemplate(priv.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := st.DeleteContestTemplate(priv.ID); !errors.Is(err, store.ErrTemplateNotFound) {
		t.Fatalf("second delete should report not-found, got %v", err)
	}
	if _, err := st.GetContestTemplate(priv.ID); !errors.Is(err, store.ErrTemplateNotFound) {
		t.Fatalf("deleted template should be gone, got %v", err)
	}
}
