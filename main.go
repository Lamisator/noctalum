package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/noctalum/noctalum/internal/server"
	"github.com/noctalum/noctalum/internal/store"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	// DATABASE_URL takes precedence over -db so the docker-compose stack can
	// inject the postgres:// connection string via env without a wrapper.
	dbDSN := flag.String("db", "", "PostgreSQL DSN (postgres://user:pass@host:5432/db?sslmode=disable). If empty, DATABASE_URL env is used.")
	dataDir := flag.String("data-dir", "/var/lib/noctalum", "directory for on-disk runtime state (sounds, callsign_proofs, shutdown_trigger)")
	downloadsDir := flag.String("downloads-dir", "", "directory to serve helper downloads from (optional)")
	// Empty backups-dir disables the /api/backups endpoints + daily
	// scheduler — useful for local dev without wanting a growing
	// pgdump collection on disk.
	backupsDir := flag.String("backups-dir", "/backups", "directory where daily/manual DB backups are written (empty = disabled)")
	flag.Parse()

	dsn := *dbDSN
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		log.Fatal("no database DSN configured: set -db or the DATABASE_URL env var")
	}

	st, err := store.Open(dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer st.Close()

	srv, err := server.New(st)
	if err != nil {
		log.Fatalf("init server: %v", err)
	}
	if *downloadsDir != "" {
		srv.SetDownloadsDir(*downloadsDir)
	}
	// The runtime file-based state (sounds, callsign proofs, shutdown
	// trigger) used to be derived from the SQLite file's parent directory.
	// With Postgres there is no local db file, so an explicit -data-dir
	// carries that role. All three subpaths live under it so the deploy
	// script can bind-mount a single volume for user data.
	srv.SetSoundsDir(filepath.Join(*dataDir, "sounds"))
	srv.SetCallsignProofsDir(filepath.Join(*dataDir, "callsign_proofs"))
	srv.SetShutdownTriggerPath(filepath.Join(*dataDir, "shutdown_trigger"))
	srv.SetBackupsDir(*backupsDir)

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("Noctalum listening on %s (data-dir=%s)", *addr, *dataDir)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	<-sigs
	log.Println("shutting down…")
	srv.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}
