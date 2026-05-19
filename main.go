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
	dbPath := flag.String("db", "noctalum.db", "SQLite database file path")
	downloadsDir := flag.String("downloads-dir", "", "directory to serve helper downloads from (optional)")
	flag.Parse()

	st, err := store.Open(*dbPath)
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
	// Derive sounds directory from db location so no extra flag is needed.
	srv.SetSoundsDir(filepath.Join(filepath.Dir(*dbPath), "sounds"))

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("Noctalum listening on %s (db=%s)", *addr, *dbPath)
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
