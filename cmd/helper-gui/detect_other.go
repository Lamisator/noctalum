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
			"/opt/homebrew/bin/rigctld", // Apple Silicon
			"/usr/local/bin/rigctld",    // Intel
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return "rigctld"
}

func defaultRigctlBin() string {
	if bin := embeddedRigctlBin(); bin != "" {
		return bin
	}
	if path, err := exec.LookPath("rigctl"); err == nil {
		return path
	}
	if runtime.GOOS == "darwin" {
		for _, p := range []string{
			"/opt/homebrew/bin/rigctl",
			"/usr/local/bin/rigctl",
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return "rigctl"
}

func detectSerialPorts() []string {
	patterns := []string{
		"/dev/ttyUSB*",
		"/dev/ttyACM*",
		"/dev/cu.usbserial*",
		"/dev/cu.SLAB_USBtoUART*",
		"/dev/cu.usbmodem*",
	}
	var ports []string
	for _, pat := range patterns {
		matches, _ := filepath.Glob(pat)
		ports = append(ports, matches...)
	}
	sort.Strings(ports)
	return ports
}
