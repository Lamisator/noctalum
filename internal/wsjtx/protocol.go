// Package wsjtx decodes WSJT-X's NetworkMessage UDP packets.  We only care
// about the LOG_QSO message (type 5) — anything else on the socket is
// silently ignored so an operator can leave the CLI/GUI bridge listening
// on WSJT-X's status port without conflict.
//
// Reference: https://sourceforge.net/p/wsjt/wsjtx/ci/master/tree/Network/NetworkMessage.hpp
// Schema versions 2 and 3 differ only in a trailing AdifPropagationMode
// field on LOG_QSO; because it's the last field, we read it implicitly by
// letting the reader run out of bytes.
package wsjtx

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"time"
)

const (
	magic       = uint32(0xADBCCBDA)
	msgLogQSO   = uint32(5)
	julianEpoch = int64(2440588) // Julian day of Unix epoch 1970-01-01
)

// LogQSO is one completed contact parsed out of a LOG_QSO datagram.  The
// zero value is not meaningful; use ParseLogQSO instead.
//
// Fields that the Noctalum server doesn't use (MyGrid, ExchangeSent,
// ExchangeReceived, ...) are parsed but not exposed here — they would only
// clutter the surface for a bridge that discards them anyway.
type LogQSO struct {
	DateTimeOff    time.Time
	DxCall         string
	DxGrid         string
	DialFrequency  uint64
	Mode           string
	ReportSent     string
	ReportReceived string
	TxPower        string
	Comments       string
	Name           string
	DateTimeOn     time.Time
	// OperatorCall names the human operator when WSJT-X is configured for
	// a multi-op session; typically empty for the single-op case.  We
	// currently ignore it in favour of MyCall for the "who transmitted?"
	// check because we want the station identity, not the guest op.
	OperatorCall string
	// MyCall is the station callsign WSJT-X was configured with when this
	// QSO was logged.  Compared against the contest's expected
	// station_call by both the client-side filter (Session in the GUI
	// bridge) and the server-side safety net (/api/wsjtx/qsos).
	MyCall           string
	MyGrid           string
	ExchangeSent     string
	ExchangeReceived string
}

// Time returns the best "when did this QSO happen" timestamp — WSJT-X's
// DateTimeOn if it was populated, otherwise DateTimeOff.  Both are UTC.
func (m *LogQSO) Time() time.Time {
	if !m.DateTimeOn.IsZero() {
		return m.DateTimeOn
	}
	return m.DateTimeOff
}

// Notes joins the WSJT-X Name and Comments fields into a single
// human-readable "notes" string suitable for POSTing to the server.
// Empty result when both inputs are empty.
func (m *LogQSO) Notes() string {
	name := trim(m.Name)
	comments := trim(m.Comments)
	switch {
	case name == "" && comments == "":
		return ""
	case name == "":
		return comments
	case comments == "":
		return name
	}
	return name + " " + comments
}

// ParseLogQSO decodes a UDP datagram as a WSJT-X LOG_QSO message.  Returns
// an error for any packet that isn't LOG_QSO (magic mismatch, wrong type)
// so callers can just ignore the error and continue reading the socket.
func ParseLogQSO(data []byte) (*LogQSO, error) {
	r := bytes.NewReader(data)

	m, err := ru32(r)
	if err != nil || m != magic {
		return nil, fmt.Errorf("not wsjtx magic")
	}
	if _, err := ru32(r); err != nil { // schema version — tolerated as-is
		return nil, err
	}
	mt, err := ru32(r)
	if err != nil || mt != msgLogQSO {
		return nil, fmt.Errorf("not LOG_QSO (type %d)", mt)
	}
	if _, err := rstr(r); err != nil { // client id
		return nil, err
	}

	var q LogQSO
	if q.DateTimeOff, err = rdt(r); err != nil {
		return nil, fmt.Errorf("DateTimeOff: %w", err)
	}
	if q.DxCall, err = rstr(r); err != nil {
		return nil, fmt.Errorf("DxCall: %w", err)
	}
	if q.DxGrid, err = rstr(r); err != nil {
		return nil, fmt.Errorf("DxGrid: %w", err)
	}
	if q.DialFrequency, err = ru64(r); err != nil {
		return nil, fmt.Errorf("DialFrequency: %w", err)
	}
	if q.Mode, err = rstr(r); err != nil {
		return nil, fmt.Errorf("Mode: %w", err)
	}
	if q.ReportSent, err = rstr(r); err != nil {
		return nil, fmt.Errorf("ReportSent: %w", err)
	}
	if q.ReportReceived, err = rstr(r); err != nil {
		return nil, fmt.Errorf("ReportReceived: %w", err)
	}
	if q.TxPower, err = rstr(r); err != nil {
		return nil, fmt.Errorf("TxPower: %w", err)
	}
	if q.Comments, err = rstr(r); err != nil {
		return nil, fmt.Errorf("Comments: %w", err)
	}
	if q.Name, err = rstr(r); err != nil {
		return nil, fmt.Errorf("Name: %w", err)
	}
	if q.DateTimeOn, err = rdt(r); err != nil {
		return nil, fmt.Errorf("DateTimeOn: %w", err)
	}
	if q.OperatorCall, err = rstr(r); err != nil {
		return nil, fmt.Errorf("OperatorCall: %w", err)
	}
	if q.MyCall, err = rstr(r); err != nil {
		return nil, fmt.Errorf("MyCall: %w", err)
	}
	if q.MyGrid, err = rstr(r); err != nil {
		return nil, fmt.Errorf("MyGrid: %w", err)
	}
	if q.ExchangeSent, err = rstr(r); err != nil {
		return nil, fmt.Errorf("ExchangeSent: %w", err)
	}
	if q.ExchangeReceived, err = rstr(r); err != nil {
		return nil, fmt.Errorf("ExchangeReceived: %w", err)
	}
	// AdifPropagationMode (schema >= 3) is the last field; letting r hit
	// EOF is fine — we never use it.

	if q.DxCall == "" {
		return nil, fmt.Errorf("empty DX callsign")
	}
	return &q, nil
}

// ---------- WSJT-X wire format helpers ----------
//
// utf8-string: uint32 byte-count (0 or 0xFFFFFFFF = null/empty) + UTF-8 bytes
// QDateTime:   uint64 Julian-day + uint32 ms-since-midnight + uint8 timeSpec

func ru32(r io.Reader) (uint32, error) {
	var v uint32
	return v, binary.Read(r, binary.BigEndian, &v)
}

func ru64(r io.Reader) (uint64, error) {
	var v uint64
	return v, binary.Read(r, binary.BigEndian, &v)
}

func rstr(r io.Reader) (string, error) {
	n, err := ru32(r)
	if err != nil {
		return "", err
	}
	if n == 0 || n == 0xFFFFFFFF {
		return "", nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func rdt(r io.Reader) (time.Time, error) {
	jd, err := ru64(r)
	if err != nil {
		return time.Time{}, err
	}
	ms, err := ru32(r)
	if err != nil {
		return time.Time{}, err
	}
	var spec uint8
	if err := binary.Read(r, binary.BigEndian, &spec); err != nil {
		return time.Time{}, err
	}
	sec := (int64(jd)-julianEpoch)*86400 + int64(ms)/1000
	ns := int64(ms%1000) * 1e6
	return time.Unix(sec, ns).UTC(), nil
}

// trim is a local strings.TrimSpace shim to keep this file dependency-free
// for future use as a documentation example.
func trim(s string) string {
	for len(s) > 0 && isSpace(s[0]) {
		s = s[1:]
	}
	for len(s) > 0 && isSpace(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}
