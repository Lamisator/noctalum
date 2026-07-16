package backup

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Dump writes a self-contained SQL restore script covering every table
// in the public schema to w.
//
// Format is a single transaction:
//
//   BEGIN;
//   TRUNCATE t1, t2, … RESTART IDENTITY CASCADE;   -- order-free (CASCADE)
//   INSERT INTO parent (…) VALUES (…);             -- topologically sorted:
//   INSERT INTO child  (…) VALUES (…);             -- parents before children
//   …
//   SELECT setval(pg_get_serial_sequence('t', 'id'), COALESCE(MAX(id), 1));
//   COMMIT;
//
// Restore with: `zcat noctalum-*.sql.gz | psql <dsn>`. The target DB
// must already have the schema (the app's own migrate() creates it on
// first boot; the dump doesn't ship DDL).
//
// FK ordering is done in-band (topological sort on pg_constraint) rather
// than via `SET session_replication_role = replica` because that
// statement needs SUPERUSER privileges — which the noctalum role
// deliberately doesn't have.
//
// A REPEATABLE READ read-only transaction wraps the reads so all tables
// see a consistent snapshot even though writers may be active. Postgres
// gives that snapshot for free without blocking anyone.
func Dump(ctx context.Context, db *sql.DB, w io.Writer) error {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelRepeatableRead,
		ReadOnly:  true,
	})
	if err != nil {
		return fmt.Errorf("begin snapshot tx: %w", err)
	}
	defer tx.Rollback()

	tables, err := listTables(ctx, tx)
	if err != nil {
		return err
	}
	if len(tables) == 0 {
		return fmt.Errorf("no tables found in public schema")
	}
	loadOrder, err := topoSortTables(ctx, tx, tables)
	if err != nil {
		return fmt.Errorf("topo sort: %w", err)
	}

	if _, err := fmt.Fprintln(w, "-- Noctalum backup — restore with: zcat file.sql.gz | psql <dsn>"); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(w, "-- NOTE: target DB must already have the schema (start the app once against a fresh Postgres to create it)."); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(w, "BEGIN;"); err != nil {
		return err
	}
	// TRUNCATE order is not sensitive: CASCADE handles the FK graph for
	// deletion in one atomic statement. We list every table so nothing
	// stale survives the restore.
	if _, err := fmt.Fprintf(w, "TRUNCATE %s RESTART IDENTITY CASCADE;\n", strings.Join(quoteIdents(tables), ", ")); err != nil {
		return err
	}

	// INSERT order IS sensitive — parents must be present before children.
	for _, t := range loadOrder {
		if err := dumpTable(ctx, tx, w, t); err != nil {
			return fmt.Errorf("table %s: %w", t, err)
		}
	}

	// Reset every BIGSERIAL-backed sequence past MAX(id) so post-restore
	// INSERTs don't collide with existing rows.
	seqTables, err := listSequencedTables(ctx, tx)
	if err != nil {
		return err
	}
	for _, t := range seqTables {
		if _, err := fmt.Fprintf(w,
			"SELECT setval(pg_get_serial_sequence(%s, 'id'), COALESCE((SELECT MAX(id) FROM %s), 1), (SELECT COUNT(*) > 0 FROM %s));\n",
			sqlString(t), quoteIdent(t), quoteIdent(t)); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprintln(w, "COMMIT;"); err != nil {
		return err
	}
	return nil
}

// topoSortTables returns tables in dependency order (parents before
// children) based on the FK graph in pg_constraint. Self-references
// (contype='f' with conrelid==confrelid) are ignored — they don't
// affect load order. Ties are broken alphabetically for deterministic
// output.
func topoSortTables(ctx context.Context, tx *sql.Tx, tables []string) ([]string, error) {
	inScope := make(map[string]bool, len(tables))
	for _, t := range tables {
		inScope[t] = true
	}

	// edges[child] = list of parents (child depends on parent).
	edges := map[string]map[string]bool{}
	rows, err := tx.QueryContext(ctx, `
		SELECT child.relname, parent.relname
		FROM pg_constraint c
		JOIN pg_class child   ON c.conrelid  = child.oid
		JOIN pg_class parent  ON c.confrelid = parent.oid
		JOIN pg_namespace n   ON child.relnamespace = n.oid
		WHERE c.contype = 'f' AND n.nspname = 'public'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var child, parent string
		if err := rows.Scan(&child, &parent); err != nil {
			return nil, err
		}
		if child == parent {
			continue
		}
		if !inScope[child] || !inScope[parent] {
			continue
		}
		if edges[child] == nil {
			edges[child] = map[string]bool{}
		}
		edges[child][parent] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Kahn's algorithm — repeatedly emit every table whose parents
	// have already been emitted, alphabetically to tiebreak.
	inDeg := make(map[string]int, len(tables))
	for _, t := range tables {
		inDeg[t] = len(edges[t])
	}
	// Reverse: parent -> children, so we can decrement in-degrees.
	children := map[string][]string{}
	for child, parents := range edges {
		for parent := range parents {
			children[parent] = append(children[parent], child)
		}
	}

	var out []string
	remaining := make(map[string]bool, len(tables))
	for _, t := range tables {
		remaining[t] = true
	}
	for len(remaining) > 0 {
		// Collect all zero-in-degree tables, sort alphabetically for
		// determinism, emit them, then drop their edges.
		var ready []string
		for t := range remaining {
			if inDeg[t] == 0 {
				ready = append(ready, t)
			}
		}
		if len(ready) == 0 {
			return nil, fmt.Errorf("FK cycle detected; %d tables remaining", len(remaining))
		}
		sort.Strings(ready)
		for _, t := range ready {
			out = append(out, t)
			delete(remaining, t)
			for _, c := range children[t] {
				inDeg[c]--
			}
		}
	}
	return out, nil
}

func listTables(ctx context.Context, tx *sql.Tx) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public'
		ORDER BY tablename`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func listSequencedTables(ctx context.Context, tx *sql.Tx) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT table_name FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND column_name = 'id'
		  AND column_default LIKE 'nextval(%'
		ORDER BY table_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func listColumns(ctx context.Context, tx *sql.Tx, table string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = $1
		ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func dumpTable(ctx context.Context, tx *sql.Tx, w io.Writer, table string) error {
	cols, err := listColumns(ctx, tx, table)
	if err != nil {
		return err
	}
	if len(cols) == 0 {
		return nil
	}
	q := fmt.Sprintf(`SELECT %s FROM %s`,
		strings.Join(quoteIdents(cols), ", "), quoteIdent(table))
	rows, err := tx.QueryContext(ctx, q)
	if err != nil {
		return err
	}
	defer rows.Close()

	colList := strings.Join(quoteIdents(cols), ", ")
	insertPrefix := fmt.Sprintf("INSERT INTO %s (%s) VALUES (", quoteIdent(table), colList)

	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		if _, err := io.WriteString(w, insertPrefix); err != nil {
			return err
		}
		for i, v := range vals {
			if i > 0 {
				if _, err := io.WriteString(w, ", "); err != nil {
					return err
				}
			}
			if err := writeSQLLiteral(w, v); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(w, ");\n"); err != nil {
			return err
		}
	}
	return rows.Err()
}

// writeSQLLiteral emits one Postgres-syntax literal for v. Covers every
// type our schema uses (nothing exotic like JSONB, ARRAY, or BYTEA — if
// we introduce those, add cases here). Anything unrecognised falls
// through to a stringly-typed representation, which is safer than
// crashing but flags that a type was missed.
func writeSQLLiteral(w io.Writer, v any) error {
	if v == nil {
		_, err := io.WriteString(w, "NULL")
		return err
	}
	switch x := v.(type) {
	case string:
		_, err := io.WriteString(w, sqlString(x))
		return err
	case []byte:
		// pgx returns TEXT as string when scanned into *any, but the
		// stdlib driver can flip to []byte for some cases. Treat as
		// UTF-8 text — our schema has no BYTEA columns.
		_, err := io.WriteString(w, sqlString(string(x)))
		return err
	case bool:
		if x {
			_, err := io.WriteString(w, "true")
			return err
		}
		_, err := io.WriteString(w, "false")
		return err
	case int64:
		_, err := fmt.Fprintf(w, "%d", x)
		return err
	case int:
		_, err := fmt.Fprintf(w, "%d", x)
		return err
	case int32:
		_, err := fmt.Fprintf(w, "%d", x)
		return err
	case float64:
		_, err := fmt.Fprintf(w, "%g", x)
		return err
	case time.Time:
		// Format includes microseconds + explicit UTC offset so the
		// value round-trips into TIMESTAMPTZ exactly.
		_, err := fmt.Fprintf(w, "'%s'::timestamptz",
			x.UTC().Format("2006-01-02 15:04:05.000000-07"))
		return err
	default:
		_, err := io.WriteString(w, sqlString(fmt.Sprintf("%v", x)))
		return err
	}
}

// sqlString wraps s in Postgres string quotes and doubles any embedded
// single quote — the escape sequence the SQL standard requires. Does
// NOT do any UTF-8 sanitisation; the runtime store layer (cleanStr)
// already ensures anything landing in the DB is valid UTF-8.
func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// quoteIdent wraps a Postgres identifier in double quotes and doubles
// any embedded quote. Guards against edge cases like reserved words
// showing up as column names.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func quoteIdents(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = quoteIdent(n)
	}
	return out
}
