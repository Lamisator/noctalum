//go:build !windows

package main

import "errors"

// omnirigBackend on non-Windows is a stub so the rest of the package
// still compiles.  The rigctld path is unchanged; OmniRig calls
// error out cleanly at startup and the GUI hides the option based
// on omnirigAvailable.
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

const omnirigAvailable = false
