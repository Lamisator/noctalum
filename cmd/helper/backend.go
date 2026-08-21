package main

// RigBackend abstracts the underlying rig-control mechanism (Hamlib
// rigctld, OmniRig, …) so the polling / websocket loop in session()
// doesn't care which one is producing the frequency and mode data.
//
// All methods must be safe to call from the read goroutine and the
// write goroutine concurrently; backends that wrap a non-thread-safe
// transport are expected to serialise internally.
type RigBackend interface {
	// Read returns the current frequency in Hz and a rigctld-style mode
	// name (USB / LSB / CW / …).  An error means the rig is unreachable
	// or misbehaving; the session loop reports it upstream and applies
	// exponential back-off before retrying.
	Read() (freqHz int64, mode string, err error)

	// SetFreq tunes the rig to freqHz.  Called from the server → helper
	// event handler when an operator clicks a spot or the frequency
	// box.
	SetFreq(freqHz int64) error

	// SetMode switches the rig to the given mode (rigctld-style name).
	SetMode(mode string) error

	// Close releases any resources held by the backend (a COM apartment
	// for OmniRig; nothing for rigctld since the spawned process is
	// killed by main).  Safe to call more than once.
	Close()
}

// rigctldBackend is the historical backend: it talks to a local
// Hamlib rigctld daemon over TCP using the "printf … | nc" trick
// implemented in readRig / setRigFreq / setRigMode below.
type rigctldBackend struct {
	host string
	port int
}

func (r *rigctldBackend) Read() (int64, string, error) {
	return readRig(r.host, r.port)
}

func (r *rigctldBackend) SetFreq(freqHz int64) error {
	return setRigFreq(r.host, r.port, freqHz)
}

func (r *rigctldBackend) SetMode(mode string) error {
	return setRigMode(r.host, r.port, mode)
}

func (r *rigctldBackend) Close() {}
