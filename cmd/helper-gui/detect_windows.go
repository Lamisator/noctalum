//go:build windows

package main

import (
	"os"
	"os/exec"
	"sort"

	"golang.org/x/sys/windows/registry"
)

func defaultRigctldBin() string {
	if bin := embeddedRigctldBin(); bin != "" {
		return bin
	}
	if path, err := exec.LookPath("rigctld.exe"); err == nil {
		return path
	}
	candidates := []string{
		`C:\Program Files\Hamlib\bin\rigctld.exe`,
		`C:\Program Files (x86)\Hamlib\bin\rigctld.exe`,
		`C:\hamlib\bin\rigctld.exe`,
		`C:\hamlib-w64\bin\rigctld.exe`,
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "rigctld.exe"
}

func defaultRigctlBin() string {
	if bin := embeddedRigctlBin(); bin != "" {
		return bin
	}
	if path, err := exec.LookPath("rigctl.exe"); err == nil {
		return path
	}
	candidates := []string{
		`C:\Program Files\Hamlib\bin\rigctl.exe`,
		`C:\Program Files (x86)\Hamlib\bin\rigctl.exe`,
		`C:\hamlib\bin\rigctl.exe`,
		`C:\hamlib-w64\bin\rigctl.exe`,
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "rigctl.exe"
}

func detectSerialPorts() []string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`HARDWARE\DEVICEMAP\SERIALCOMM`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer k.Close()
	names, err := k.ReadValueNames(-1)
	if err != nil {
		return nil
	}
	var ports []string
	for _, name := range names {
		val, _, err := k.GetStringValue(name)
		if err == nil {
			ports = append(ports, val)
		}
	}
	sort.Strings(ports)
	return ports
}
