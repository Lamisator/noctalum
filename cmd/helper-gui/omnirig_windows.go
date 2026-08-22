//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"

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
//
// COM apartments are per-OS-thread.  OmniRig registers as STA
// (COINIT_APARTMENTTHREADED), so every call on the engine or its
// RigX objects must happen on the exact same OS thread that created
// them — otherwise Windows returns RPC_E_WRONG_THREAD ("An interface
// that was marshalled for a different thread was called by the
// application").  A plain mutex is not enough because Go goroutines
// can migrate between OS threads between calls.  We therefore spawn
// a dedicated worker goroutine that pins itself to one OS thread via
// runtime.LockOSThread and funnel every dispatch call through it via
// a channel of closures.
type omnirigBackend struct {
	rigIndex int
	calls    chan func()
	done     chan struct{}

	// engine/unknown are only ever touched on the worker goroutine.
	engine  *ole.IDispatch
	unknown *ole.IUnknown
}

// newOmnirigBackend spawns the OS-thread-pinned COM worker and
// creates the OmniRigX engine object on it.  It does not wait for
// the rig to come online — Status is checked on every Read so a rig
// that appears mid-session is picked up automatically.
func newOmnirigBackend(rigIndex int) (*omnirigBackend, error) {
	if rigIndex != 1 && rigIndex != 2 {
		return nil, fmt.Errorf("omnirig rig index must be 1 or 2 (got %d)", rigIndex)
	}

	o := &omnirigBackend{
		rigIndex: rigIndex,
		calls:    make(chan func()),
		done:     make(chan struct{}),
	}

	initErr := make(chan error, 1)
	go o.worker(initErr)
	if err := <-initErr; err != nil {
		return nil, err
	}
	return o, nil
}

// worker is the sole goroutine that ever touches COM.  It pins
// itself to one OS thread for its entire lifetime, initialises COM
// as STA, creates the OmniRigX engine, and then services calls
// arriving on o.calls.  When o.calls is closed, it releases COM
// objects and CoUninitialize on the same thread, then closes o.done
// to signal Close() that shutdown is complete.
func (o *omnirigBackend) worker(initErr chan<- error) {
	runtime.LockOSThread()
	// Deliberately no UnlockOSThread — this goroutine exits at the
	// end of the function and the thread goes with it, which is the
	// safest disposal for a thread that has held COM state.  In
	// particular, the Wails main loop runs on its own locked thread
	// and is not affected by this one.

	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		var oe *ole.OleError
		if errors.As(err, &oe) {
			switch uint32(oe.Code()) {
			case 0x00000001: // S_FALSE — already initialised in a compatible mode, OK
			case 0x80010106: // RPC_E_CHANGED_MODE — incompatible apartment
				initErr <- fmt.Errorf("COM apartment conflict (RPC_E_CHANGED_MODE): another library initialised COM in MTA mode")
				close(o.done)
				return
			default:
				initErr <- fmt.Errorf("CoInitializeEx: %w", err)
				close(o.done)
				return
			}
		} else {
			initErr <- fmt.Errorf("CoInitializeEx: %w", err)
			close(o.done)
			return
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
		initErr <- fmt.Errorf("create OmniRig COM object: %w (is OmniRig installed and registered?)", lastErr)
		close(o.done)
		return
	}

	engine, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		unknown.Release()
		ole.CoUninitialize()
		initErr <- fmt.Errorf("query IDispatch on %s: %w", progUsed, err)
		close(o.done)
		return
	}

	o.engine = engine
	o.unknown = unknown
	initErr <- nil

	for fn := range o.calls {
		fn()
	}

	if o.engine != nil {
		o.engine.Release()
		o.engine = nil
	}
	if o.unknown != nil {
		o.unknown.Release()
		o.unknown = nil
	}
	ole.CoUninitialize()
	close(o.done)
}

// call submits fn to the worker goroutine and blocks until it
// finishes.  This is how every public method reaches COM.
func (o *omnirigBackend) call(fn func()) {
	done := make(chan struct{})
	o.calls <- func() {
		fn()
		close(done)
	}
	<-done
}

// rig returns the RigX dispatch object for the configured slot.  The
// caller must Release it when done.  MUST be invoked from the worker
// goroutine.  We refetch on every operation because OmniRig replaces
// the RigX object on rig-type changes.
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
	var (
		freq int64
		mode string
		err  error
	)
	o.call(func() {
		freq, mode, err = o.readOnWorker()
	})
	return freq, mode, err
}

func (o *omnirigBackend) readOnWorker() (int64, string, error) {
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
	var err error
	o.call(func() {
		err = o.setFreqOnWorker(freqHz)
	})
	return err
}

func (o *omnirigBackend) setFreqOnWorker(freqHz int64) error {
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
	var err error
	o.call(func() {
		err = o.setModeOnWorker(mode)
	})
	return err
}

func (o *omnirigBackend) setModeOnWorker(mode string) error {
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

// Close signals the worker to release its COM state and shut down,
// then waits for it to exit.  Must not be called concurrently with
// Read/SetFreq/SetMode — the session loop stops issuing calls before
// closing the backend.
func (o *omnirigBackend) Close() {
	defer func() {
		// close on an already-closed channel panics; swallow that so
		// a double-Close is a no-op.
		_ = recover()
	}()
	close(o.calls)
	<-o.done
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
