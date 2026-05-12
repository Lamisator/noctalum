//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
)

func defaultRigctldBin() string {
	if bin := embeddedRigctldBin(); bin != "" {
		return bin
	}
	if path, err := exec.LookPath("rigctld"); err == nil {
		return path
	}
	// Common Homebrew install locations on macOS.
	if runtime.GOOS == "darwin" {
		for _, p := range []string{
			"/opt/homebrew/bin/rigctld",  // Apple Silicon
			"/usr/local/bin/rigctld",     // Intel
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return "rigctld"
}

// detectSerialPorts globs for USB serial adapters on Linux and macOS.
func detectSerialPorts() []string {
	patterns := []string{
		"/dev/ttyUSB*",          // FTDI / CP210x USB-Serial (Linux)
		"/dev/ttyACM*",          // USB CDC-ACM (Linux)
		"/dev/cu.usbserial*",    // FTDI / CP210x USB-Serial (macOS)
		"/dev/cu.SLAB_USBtoUART*", // CP2102 (macOS)
		"/dev/cu.usbmodem*",     // USB CDC (macOS)
	}
	var ports []string
	for _, pat := range patterns {
		matches, _ := filepath.Glob(pat)
		ports = append(ports, matches...)
	}
	sort.Strings(ports)
	return ports
}
