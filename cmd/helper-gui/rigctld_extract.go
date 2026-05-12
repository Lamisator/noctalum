package main

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

var (
	extractOnce  sync.Once
	extractedDir string
)

// embeddedRigctldBin extracts the bundled rigctld to a temp dir (once) and
// returns the path to the executable. Returns "" when no binary is compiled in.
func embeddedRigctldBin() string {
	if rigctldFSDir == "" {
		return ""
	}
	extractOnce.Do(func() {
		dir, err := os.MkdirTemp("", "contestlog-rigctld-*")
		if err != nil {
			log.Printf("rigctld extract: mkdir: %v", err)
			return
		}
		err = fs.WalkDir(rigctldFS, rigctldFSDir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := rigctldFS.ReadFile(path)
			if err != nil {
				return err
			}
			if len(data) == 0 {
				return nil
			}
			name := filepath.Base(path)
			dst := filepath.Join(dir, name)
			perm := os.FileMode(0644)
			if name == "rigctld" || name == "rigctld.exe" ||
				name == "rigctl" || name == "rigctl.exe" {
				perm = 0755
			}
			return os.WriteFile(dst, data, perm)
		})
		if err != nil {
			log.Printf("rigctld extract: %v", err)
			os.RemoveAll(dir)
			return
		}
		extractedDir = dir
	})
	if extractedDir == "" {
		return ""
	}
	exe := "rigctld"
	if runtime.GOOS == "windows" {
		exe = "rigctld.exe"
	}
	bin := filepath.Join(extractedDir, exe)
	if _, err := os.Stat(bin); err != nil {
		return ""
	}
	return bin
}

// embeddedRigctlBin returns the path to the extracted rigctl executable, or ""
// when rigctl is not bundled.  Piggy-backs on the same extraction pass as
// embeddedRigctldBin — call order does not matter.
func embeddedRigctlBin() string {
	_ = embeddedRigctldBin() // ensure extraction has run
	if extractedDir == "" {
		return ""
	}
	exe := "rigctl"
	if runtime.GOOS == "windows" {
		exe = "rigctl.exe"
	}
	bin := filepath.Join(extractedDir, exe)
	if _, err := os.Stat(bin); err != nil {
		return ""
	}
	return bin
}
