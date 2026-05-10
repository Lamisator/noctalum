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
