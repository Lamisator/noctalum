//go:build !windows

package main

import "errors"

// omnirigBackend on non-Windows is a stub that only exists so the
// rest of the package (which references the type name) still
// compiles.  The rigctld path is unchanged.
type omnirigBackend struct{}

func newOmnirigBackend(int) (*omnirigBackend, error) {
	return nil, errors.New("OmniRig is only available on Windows")
}

func (o *omnirigBackend) Read() (int64, string, error) {
	return 0, "", errors.New("OmniRig is only available on Windows")
}

func (o *omnirigBackend) SetFreq(int64) error {
	return errors.New("OmniRig is only available on Windows")
}

func (o *omnirigBackend) SetMode(string) error {
	return errors.New("OmniRig is only available on Windows")
}

func (o *omnirigBackend) Close() {}

// omnirigAvailable is false on non-Windows so the CLI and TUI can
// hide / disable the OmniRig option without a runtime probe.
const omnirigAvailable = false
