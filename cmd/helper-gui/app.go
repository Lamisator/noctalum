package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the bound struct exposed to the frontend.  Its exported methods are
// callable as window.go.main.App.<Method>(...) from JavaScript.
type App struct {
	ctx context.Context

	mu       sync.Mutex
	cancel   context.CancelFunc
	rigctld  *exec.Cmd
	running  bool
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	wruntime.LogInfo(ctx, "Noctalum Helper GUI v"+helperVersion+" starting")
}

func (a *App) shutdown(_ context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
	if a.rigctld != nil && a.rigctld.Process != nil {
		_ = a.rigctld.Process.Kill()
	}
}

// emit pushes a typed event to the frontend.  Wrapped so we can centralise
// guard-against-nil-ctx and structure logging in one place.
func (a *App) emit(event string, payload any) {
	if a.ctx == nil {
		return
	}
	wruntime.EventsEmit(a.ctx, event, payload)
}

func (a *App) emitLog(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	a.emit("log", msg)
	if a.ctx != nil {
		wruntime.LogPrint(a.ctx, msg)
	}
}

// Phase is the lifecycle of a Connect attempt as shown by the step icons.
type Phase string

const (
	PhaseModel      Phase = "model"
	PhaseBaud       Phase = "baud"
	PhaseConnecting Phase = "connecting"
	PhaseConnected  Phase = "connected"
)

// PhaseState mirrors the CSS classes used by the icon row.
type PhaseState string

const (
	StateIdle    PhaseState = "idle"
	StateActive  PhaseState = "active"
	StateDone    PhaseState = "done"
	StateError   PhaseState = "error"
	StateSkipped PhaseState = "skipped"
)

type phaseEvent struct {
	Phase   Phase      `json:"phase"`
	State   PhaseState `json:"state"`
	Message string     `json:"message,omitempty"`
}

func (a *App) emitPhase(p Phase, s PhaseState, msg string) {
	a.emit("phase", phaseEvent{Phase: p, State: s, Message: msg})
}

// statusEvent reports whether the helper is currently connected (rigctld
// running and session loop active).  The frontend uses this to drive the
// Connect / Disconnect button.
type statusEvent struct {
	Running bool   `json:"running"`
	Error   string `json:"error,omitempty"`
}

func (a *App) emitStatus(running bool, err error) {
	ev := statusEvent{Running: running}
	if err != nil {
		ev.Error = err.Error()
	}
	a.emit("status", ev)
}

// rigctldParamsEvent is the neat parameter readout shown after Connect
// succeeds.  Order is the order rigctld sees on the command line.
type rigctldParamsEvent struct {
	Binary   string `json:"binary"`
	Model    int    `json:"model"`
	RigLabel string `json:"rig_label"`
	Device   string `json:"device"`
	Speed    int    `json:"speed"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Args     string `json:"args"`
}

// Bound API ---------------------------------------------------------------

// Version returns the helper version, used by the frontend footer.
func (a *App) Version() string { return helperVersion }

// DetectPorts returns the list of serial devices that look like a USB-CAT
// adapter on the current OS.  Empty when no adapters are connected or when
// the platform-specific lookup fails (the frontend falls back to a free-text
// input in that case).
func (a *App) DetectPorts() []string {
	return detectSerialPorts()
}

// RigPresets returns the curated list of rig models the auto-probe walks
// through.  The frontend shows the same list in the manual configuration
// dropdown so the operator never has to memorise model numbers.
func (a *App) RigPresets() []RigPreset {
	out := make([]RigPreset, len(curatedRigs))
	copy(out, curatedRigs)
	return out
}

// AllRigs queries the bundled (or system) rigctld for the complete list of
// supported rig models.  Falls back to the curated short-list when rigctld
// cannot be reached.
func (a *App) AllRigs() []RigPreset {
	rigs := queryAllRigs(defaultRigctldBin())
	if len(rigs) == 0 {
		return a.RigPresets()
	}
	return rigs
}

// DefaultRigctldBin returns the discovered absolute path to rigctld so the
// frontend can prefill the manual binary field.
func (a *App) DefaultRigctldBin() string {
	return defaultRigctldBin()
}

// DefaultRigctlBin returns the path to rigctl (the interactive CLI tool,
// distinct from rigctld which is the daemon).
func (a *App) DefaultRigctlBin() string {
	return defaultRigctlBin()
}

// IsRunning is read by the frontend on startup so a newly opened window
// reflects the daemon's actual state (after a window reopen Wails keeps the
// Go process alive).
func (a *App) IsRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}

// Profiles ----------------------------------------------------------------

func (a *App) LoadProfiles() ProfileStore { return loadProfileStore() }

func (a *App) SaveProfile(p Profile) (ProfileStore, error) {
	if p.Name == "" {
		return ProfileStore{}, errors.New("profile name is required")
	}
	store := loadProfileStore()
	store.upsert(p)
	if err := store.save(); err != nil {
		return ProfileStore{}, err
	}
	return store, nil
}

func (a *App) DeleteProfile(name string) (ProfileStore, error) {
	store := loadProfileStore()
	store.remove(name)
	if err := store.save(); err != nil {
		return ProfileStore{}, err
	}
	return store, nil
}

func (a *App) SetLastProfile(name string) error {
	store := loadProfileStore()
	store.LastUsed = name
	return store.save()
}

// Connect orchestrates a full attempt: optionally auto-detects rig + baud,
// starts rigctld, and runs the Noctalum session loop until Disconnect()
// or shutdown.  Errors during phases are surfaced as phase events; the
// returned error is only set when the request can't even start (e.g. a
// previous connection is still active).
func (a *App) Connect(req ConnectRequest) error {
	a.mu.Lock()
	if a.running {
		a.mu.Unlock()
		return errors.New("already connected — disconnect first")
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.running = true
	a.mu.Unlock()

	a.emitStatus(true, nil)

	go func() {
		err := a.runSession(ctx, req)
		a.mu.Lock()
		a.running = false
		if a.rigctld != nil && a.rigctld.Process != nil {
			_ = a.rigctld.Process.Kill()
			a.rigctld = nil
		}
		a.cancel = nil
		a.mu.Unlock()
		a.emitStatus(false, err)
	}()
	return nil
}

func (a *App) Disconnect() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
}
