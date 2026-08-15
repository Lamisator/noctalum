package server

import (
	"io"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/noctalum/noctalum/internal/store"
)

// AllSystemLogLevels is the canonical set of severity values exposed to
// the frontend so it can populate the level filter dropdown.
var AllSystemLogLevels = []string{
	string(store.SysDebug),
	string(store.SysInfo),
	string(store.SysWarn),
	string(store.SysError),
}

// -----------------------------------------------------------------------------
// Package-level logger singleton.
//
// The system log has to accept writes from three very different places:
//
//   1. Explicit calls through Server.sysLog* helpers (typed level + source).
//   2. Ad-hoc log.Printf(...) calls all over the codebase — those pre-date
//      the system log and rewriting each of the ~120 call sites would be a
//      massive touch that has nothing to do with the feature. Instead we
//      install a global log.SetOutput() interceptor that parses each line,
//      derives a level + source from prefixes/keywords, and stores it.
//   3. Background goroutines (backup scheduler, cluster reader, session
//      cleanup) that don't have an *http.Request to pass around.
//
// A singleton makes (2) and (3) trivial: the log writer created by main.go
// doesn't need to know which Server owns the store, and background code can
// just call SysLog(...) without threading a reference.
// -----------------------------------------------------------------------------

var globalSysLog struct {
	mu    sync.RWMutex
	store *store.Store
}

// installSystemLogger records the store the process-wide logger should
// write to and rewires the Go log package so every log.Printf/Println
// call ends up in the database. Idempotent: safe to call more than once
// (later calls just update the store pointer).
func installSystemLogger(st *store.Store) {
	globalSysLog.mu.Lock()
	first := globalSysLog.store == nil
	globalSysLog.store = st
	globalSysLog.mu.Unlock()
	if first {
		// Preserve stderr so container logs / systemd journal still see
		// every line. The tee'd writer is what feeds the DB.
		log.SetOutput(io.MultiWriter(os.Stderr, &sysLogWriter{}))
	}
}

// SysLog writes one line to the system log at the given level. Callers
// that live inside the server package should prefer the Server.sysLog*
// helpers so a typed source is inferred from the caller; SysLog is the
// escape hatch for background goroutines that only have package-level
// context.
func SysLog(level store.SysLevel, source, message string) {
	globalSysLog.mu.RLock()
	st := globalSysLog.store
	globalSysLog.mu.RUnlock()
	if st == nil || message == "" {
		return
	}
	// Swallow the error — the log write already went to stderr via the
	// MultiWriter above, and failing the caller because we couldn't
	// persist the message would defeat the point of a log system.
	_ = st.InsertSystemLog(level, source, message)
}

// -----------------------------------------------------------------------------
// Server-scoped helpers.
//
// These are thin wrappers around SysLog() that pin a source label. They
// exist so future code can grep for "s.sysError(" and see every explicit
// error the server records — the free-form log.Printf calls end up in
// the same table but are routed through the writer below.
// -----------------------------------------------------------------------------

func (s *Server) sysLog(level store.SysLevel, source, message string) {
	SysLog(level, source, message)
}

// -----------------------------------------------------------------------------
// Interceptor for the standard log package.
//
// Go's log package writes one flushed line per Print/Printf/Println call
// (the internal buffer is joined and terminated with '\n' before Write
// is invoked). We rely on that: each Write() we receive is exactly one
// log record, so we don't need to buffer across calls.
//
// The prefix used by all Noctalum callers is "component: rest of line"
// — see cluster.go ("cluster: ..."), backup.go ("backup: ..."),
// server.go ("shutdown trigger: ..."), etc. The regexp below pulls that
// out so the UI can filter by source. Lines that don't match get the
// generic "log" source, which is still filterable but doesn't lie about
// where they came from.
// -----------------------------------------------------------------------------

type sysLogWriter struct{}

// sourcePrefixRE captures the "component: " prefix convention used
// throughout the codebase. Component names are lowercase words possibly
// containing hyphens (e.g. "shutdown trigger:", "cluster:", "backup:").
// We allow up to three space-separated words in the prefix so
// "shutdown trigger:" is picked up as source="shutdown trigger".
var sourcePrefixRE = regexp.MustCompile(`^([a-z][a-z0-9_-]*(?:\s[a-z][a-z0-9_-]*){0,2})\s*:\s`)

func (sysLogWriter) Write(p []byte) (int, error) {
	// log.Logger includes a trailing '\n'. Strip it for storage; keep
	// the return count accurate so io.MultiWriter is happy.
	n := len(p)
	line := strings.TrimRight(string(p), "\r\n")
	if line != "" {
		level, source, msg := classifyLogLine(line)
		SysLog(level, source, msg)
	}
	return n, nil
}

// classifyLogLine turns a raw log.Printf line into a (level, source,
// message) triple. The heuristics are intentionally conservative — this
// runs on every log write in the process, so nothing here should
// allocate or scan more than the line itself.
func classifyLogLine(line string) (store.SysLevel, string, string) {
	// Strip the log package's own timestamp prefix ("2026/08/15
	// 12:34:56 ") if it's present. We don't set log.LstdFlags on
	// purpose in main.go, but Go's default logger does, and the CLI
	// helpers in cmd/ that share this binary at some point would
	// otherwise store timestamped duplicates.
	trimmed := line
	if len(trimmed) >= 20 && trimmed[4] == '/' && trimmed[7] == '/' && trimmed[10] == ' ' && trimmed[13] == ':' && trimmed[16] == ':' {
		trimmed = strings.TrimSpace(trimmed[19:])
	}

	source := "log"
	if m := sourcePrefixRE.FindStringSubmatch(trimmed); m != nil {
		source = m[1]
		trimmed = trimmed[len(m[0]):]
	}

	lower := strings.ToLower(trimmed)
	level := store.SysInfo
	switch {
	case strings.HasPrefix(lower, "error"),
		strings.HasPrefix(lower, "err "),
		strings.HasPrefix(lower, "fatal"),
		strings.Contains(lower, " error:"),
		strings.Contains(lower, " failed"),
		strings.Contains(lower, "failure"),
		strings.HasSuffix(lower, " error"):
		level = store.SysError
	case strings.HasPrefix(lower, "warning"),
		strings.HasPrefix(lower, "warn "),
		strings.Contains(lower, " warning:"):
		level = store.SysWarn
	}
	return level, source, trimmed
}

// Compile-time assertion that sysLogWriter satisfies io.Writer — cheap
// insurance in case a future refactor changes the method signature.
var _ io.Writer = (*sysLogWriter)(nil)
