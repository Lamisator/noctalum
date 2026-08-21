package main

// RigBackend abstracts the underlying rig-control mechanism (Hamlib
// rigctld, OmniRig, …) so the bridge loop in session.go doesn't need
// to know which one is producing the frequency and mode data.
//
// Concurrent use: the poll loop calls Read from one goroutine while
// the websocket handler calls SetFreq / SetMode from another;
// backends must serialise internally as needed.
type RigBackend interface {
	Read() (freqHz int64, mode string, err error)
	SetFreq(freqHz int64) error
	SetMode(mode string) error
	Close()
}

// rigctldBackend wraps the historical rigctld TCP path (spawned or
// external).  The bridge holds the rigctld host/port and forwards
// every call through the freestanding rigQuery helpers in rigctl.go.
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
