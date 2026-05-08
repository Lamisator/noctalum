//go:build !windows

package main

import (
	"os/exec"
	"path/filepath"
	"sort"
)

func defaultRigctldBin() string {
	if path, err := exec.LookPath("rigctld"); err == nil {
		return path
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
