//go:build windows

package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// OmniRig mode bit constants (from OmniRig documentation).  Each
// mode is a single flag; the Mode property is a bit-mask where
// exactly one of these bits is set at a time.
const (
	pmCwU  = 0x00800000
	pmCwL  = 0x01000000
	pmSsbU = 0x02000000
	pmSsbL = 0x04000000
	pmDigU = 0x08000000
	pmDigL = 0x10000000
	pmAm   = 0x20000000
	pmFm   = 0x40000000
)

// OmniRig Status values.  Only ST_ONLINE means the CAT link is
// actually up and freq/mode reads will be meaningful.
const (
	stNotConfigured = 0
	stDisabled      = 1
	stPortBusy      = 2
	stNotResponding = 3
	stOnline        = 4
)

// omnirigProgIDs lists the COM ProgIDs to try when creating the
// OmniRigX engine.  v2 (Alex Shovkoplyas' current maintained fork)
// registers as "OmniRig.OmniRigX"; classic v1 uses a hyphenated
// ProgID.  Try v2 first, then fall back so legacy installs keep
// working.
var omnirigProgIDs = []string{
	"OmniRig.OmniRigX",
	"Omni-Rig.OmniRigX",
}

// omnirigBackend talks to OmniRig via late-bound COM (IDispatch), so
// this build has no compile-time dependency on the OmniRig SDK — any
// installed version registered on the machine works.
type omnirigBackend struct {
	rigIndex int

	// COM is not free-threaded and the OmniRig object is
	// apartment-scoped, so every dispatch call is serialised through
	// this mutex.  We do not LockOSThread here because the Wails main
	// loop and the session goroutine would fight over it; STA
	// re-entry from a single goroutine works in practice as long as
	// calls are serialised.
	mu sync.Mutex

	engine  *ole.IDispatch
	unknown *ole.IUnknown
}

// newOmnirigBackend initialises COM and creates the OmniRigX engine
// object.  It does not wait for the rig to come online — Status is
// checked on every Read so a rig that appears mid-session is picked
// up automatically.
func newOmnirigBackend(rigIndex int) (*omnirigBackend, error) {
	if rigIndex != 1 && rigIndex != 2 {
		return nil, fmt.Errorf("omnirig rig index must be 1 or 2 (got %d)", rigIndex)
	}

	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		var oe *ole.OleError
		if errors.As(err, &oe) {
			switch uint32(oe.Code()) {
			case 0x00000001: // S_FALSE — already initialised, OK
			case 0x80010106: // RPC_E_CHANGED_MODE — incompatible apartment
				return nil, fmt.Errorf("COM apartment conflict (RPC_E_CHANGED_MODE): another library initialised COM in MTA mode")
			default:
				return nil, fmt.Errorf("CoInitializeEx: %w", err)
			}
		} else {
			return nil, fmt.Errorf("CoInitializeEx: %w", err)
		}
	}

	var (
		unknown  *ole.IUnknown
		lastErr  error
		progUsed string
	)
	for _, prog := range omnirigProgIDs {
		u, err := oleutil.CreateObject(prog)
		if err == nil {
			unknown = u
			progUsed = prog
			break
		}
		lastErr = err
	}
	if unknown == nil {
		ole.CoUninitialize()
		return nil, fmt.Errorf("create OmniRig COM object: %w (is OmniRig installed and registered?)", lastErr)
	}

	engine, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		unknown.Release()
		ole.CoUninitialize()
		return nil, fmt.Errorf("query IDispatch on %s: %w", progUsed, err)
	}

	return &omnirigBackend{
		rigIndex: rigIndex,
		engine:   engine,
		unknown:  unknown,
	}, nil
}

// rig returns the RigX dispatch object for the configured slot.  The
// caller must Release it when done.  We refetch on every operation
// because OmniRig replaces the RigX object on rig-type changes.
func (o *omnirigBackend) rig() (*ole.IDispatch, error) {
	property := fmt.Sprintf("Rig%d", o.rigIndex)
	result, err := oleutil.GetProperty(o.engine, property)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", property, err)
	}
	disp := result.ToIDispatch()
	if disp == nil {
		return nil, fmt.Errorf("%s returned no dispatch", property)
	}
	return disp, nil
}

func (o *omnirigBackend) Read() (int64, string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	r, err := o.rig()
	if err != nil {
		return 0, "", err
	}
	defer r.Release()

	stRes, err := oleutil.GetProperty(r, "Status")
	if err != nil {
		return 0, "", fmt.Errorf("get Status: %w", err)
	}
	status := int(stRes.Val)
	if status != stOnline {
		return 0, "", omnirigStatusError(r, o.rigIndex, status)
	}

	fRes, err := oleutil.GetProperty(r, "Freq")
	if err != nil {
		return 0, "", fmt.Errorf("get Freq: %w", err)
	}
	freq := fRes.Val
	if freq <= 0 {
		return 0, "", errors.New("OmniRig returned non-positive frequency")
	}

	mRes, err := oleutil.GetProperty(r, "Mode")
	var mode string
	if err == nil {
		mode = omnirigModeName(mRes.Val)
	}
	return freq, mode, nil
}

func (o *omnirigBackend) SetFreq(freqHz int64) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	r, err := o.rig()
	if err != nil {
		return err
	}
	defer r.Release()

	if _, err := oleutil.PutProperty(r, "Freq", freqHz); err != nil {
		return fmt.Errorf("set Freq: %w", err)
	}
	return nil
}

func (o *omnirigBackend) SetMode(mode string) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	r, err := o.rig()
	if err != nil {
		return err
	}
	defer r.Release()

	var freqHz int64
	if fRes, err := oleutil.GetProperty(r, "Freq"); err == nil {
		freqHz = fRes.Val
	}
	bits := toOmnirigMode(mode, freqHz)
	if bits == 0 {
		return nil
	}
	if _, err := oleutil.PutProperty(r, "Mode", bits); err != nil {
		return fmt.Errorf("set Mode: %w", err)
	}
	return nil
}

func (o *omnirigBackend) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.engine != nil {
		o.engine.Release()
		o.engine = nil
	}
	if o.unknown != nil {
		o.unknown.Release()
		o.unknown = nil
	}
	ole.CoUninitialize()
}

func omnirigStatusError(rig *ole.IDispatch, rigIndex, status int) error {
	if s, err := oleutil.GetProperty(rig, "StatusStr"); err == nil {
		if v := s.ToString(); v != "" {
			return fmt.Errorf("OmniRig Rig%d: %s", rigIndex, v)
		}
	}
	label := map[int]string{
		stNotConfigured: "not configured",
		stDisabled:      "disabled",
		stPortBusy:      "port busy",
		stNotResponding: "not responding",
	}[status]
	if label == "" {
		label = fmt.Sprintf("status %d", status)
	}
	return fmt.Errorf("OmniRig Rig%d: %s", rigIndex, label)
}

func toOmnirigMode(mode string, freqHz int64) int64 {
	switch strings.ToUpper(mode) {
	case "CW":
		return pmCwU
	case "USB":
		return pmSsbU
	case "LSB":
		return pmSsbL
	case "SSB":
		if freqHz > 0 && freqHz < 10_000_000 {
			return pmSsbL
		}
		return pmSsbU
	case "AM":
		return pmAm
	case "FM":
		return pmFm
	case "RTTY", "FT8", "FT4", "PSK31", "PSK63", "JT65", "DIGI":
		return pmDigU
	default:
		return 0
	}
}

func omnirigModeName(bits int64) string {
	switch {
	case bits&(pmCwU|pmCwL) != 0:
		return "CW"
	case bits&pmSsbU != 0:
		return "USB"
	case bits&pmSsbL != 0:
		return "LSB"
	case bits&pmDigU != 0:
		return "USB"
	case bits&pmDigL != 0:
		return "LSB"
	case bits&pmAm != 0:
		return "AM"
	case bits&pmFm != 0:
		return "FM"
	default:
		return ""
	}
}

// omnirigAvailable is true on Windows builds; the frontend reads
// this via App.OmnirigAvailable() to decide whether to show the
// OmniRig option in the backend picker.
const omnirigAvailable = true
