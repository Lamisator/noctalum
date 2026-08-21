package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// ConnectRequest is what the frontend sends when the operator clicks Connect.
// AutoDetectModel=true triggers a full model scan (Phase 0) and also
// determines the baud rate, skipping the dedicated baud phase.  AutoDetect=true
// triggers baud probing only (rig model must already be supplied).
type ConnectRequest struct {
	AutoDetect      bool   `json:"auto_detect"`
	AutoDetectModel bool   `json:"auto_detect_model"`
	Server          string `json:"server"`
	Token           string `json:"token"`
	RigName         string `json:"rig_name"`
	RigModel        int    `json:"rig_model"`
	RigDevice       string `json:"rig_device"`
	RigSpeed        int    `json:"rig_speed"`
	RigctldBin      string `json:"rigctld_bin"`
	IntervalMs      int    `json:"interval_ms"`

	// Backend selects the rig control path: "rigctld" (default) or
	// "omnirig" (Windows-only, attaches to a running OmniRig COM
	// server).  Empty is treated as "rigctld" so profiles saved by
	// earlier versions upgrade seamlessly.
	Backend    string `json:"backend"`
	OmnirigRig int    `json:"omnirig_rig"`
}

const (
	backendRigctld = "rigctld"
	backendOmnirig = "omnirig"
)

// runSession is the goroutine started by Connect; it walks the phases and
// then runs the rig-backend → Noctalum bridge until ctx is cancelled.
func (a *App) runSession(ctx context.Context, req ConnectRequest) error {
	if req.IntervalMs < 250 {
		req.IntervalMs = 1000
	}
	if req.Server == "" || req.Token == "" || req.RigName == "" {
		err := errors.New("Server URL, token, and rig name are required")
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}

	switch strings.ToLower(req.Backend) {
	case backendOmnirig:
		return a.runOmnirigSession(ctx, req)
	default:
		return a.runRigctldSession(ctx, req)
	}
}

// runOmnirigSession attaches to an already-running OmniRig COM
// server on Windows.  The Model and Baud phases are skipped since
// OmniRig owns the CAT configuration itself.
func (a *App) runOmnirigSession(ctx context.Context, req ConnectRequest) error {
	if req.OmnirigRig == 0 {
		req.OmnirigRig = 1
	}

	// OmniRig owns model and baud selection — mark those phases as
	// skipped so the operator sees at a glance that we didn't touch
	// them (and doesn't mistake them for silently failed steps).
	a.emitPhase(PhaseModel, StateSkipped, "Managed by OmniRig")
	a.emitPhase(PhaseBaud, StateSkipped, "Managed by OmniRig")
	a.emitPhase(PhaseConnecting, StateActive, fmt.Sprintf("Attaching to OmniRig Rig%d…", req.OmnirigRig))

	backend, err := newOmnirigBackend(req.OmnirigRig)
	if err != nil {
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}
	defer backend.Close()

	a.emit("rigctld-params", rigctldParamsEvent{
		Binary:   "OmniRig (COM)",
		RigLabel: fmt.Sprintf("OmniRig Rig%d", req.OmnirigRig),
		Args:     fmt.Sprintf("Rig%d", req.OmnirigRig),
	})
	a.emitPhase(PhaseConnecting, StateDone, "OmniRig attached")

	a.emitPhase(PhaseConnected, StateActive, "Streaming rig state to the server")
	err = a.bridge(ctx, req, backend)
	if errors.Is(err, context.Canceled) {
		a.emitPhase(PhaseConnected, StateIdle, "Disconnected")
		return nil
	}
	a.emitPhase(PhaseConnected, StateError, err.Error())
	return err
}

// runRigctldSession is the historical path: optionally auto-detect
// model + baud, spawn a managed rigctld, then bridge it to the
// server.  Behaviour is unchanged from before OmniRig support
// landed; only the final bridge() call now goes through the
// RigBackend interface.
func (a *App) runRigctldSession(ctx context.Context, req ConnectRequest) error {
	if req.RigctldBin == "" {
		req.RigctldBin = defaultRigctldBin()
	}
	if req.RigModel == 0 && !req.AutoDetectModel {
		err := errors.New("Rig model is required — pick one from the list or enable auto-detect")
		a.emitPhase(PhaseModel, StateError, err.Error())
		return err
	}
	if req.RigDevice == "" {
		err := errors.New("Serial device is required")
		a.emitPhase(PhaseModel, StateError, err.Error())
		return err
	}

	// --- Phase 0: Auto-detect rig model ---------------------------------
	if req.AutoDetectModel {
		a.emitPhase(PhaseModel, StateActive, "Scanning serial port for connected rig…")
		model, baud, modelLabel, err := a.detectModel(ctx, req.RigctldBin, req.RigDevice)
		if err != nil {
			a.emitPhase(PhaseModel, StateError, err.Error())
			return err
		}
		req.RigModel = model
		req.RigSpeed = baud
		a.emit("detected-model", map[string]any{"model": model, "label": modelLabel, "baud": baud})
		a.emitPhase(PhaseModel, StateDone, fmt.Sprintf("Found %s @ %d baud", modelLabel, baud))
		a.emitPhase(PhaseBaud, StateSkipped, fmt.Sprintf("%d baud — found during model scan", baud))
	} else {
		a.emitPhase(PhaseModel, StateSkipped, "Manual rig model")

		label := rigByModel(req.RigModel)
		if label == "" {
			label = fmt.Sprintf("model %d", req.RigModel)
		}

		// --- Phase 1: Testing baud rate ---------------------------------
		if req.AutoDetect {
			a.emitPhase(PhaseBaud, StateActive, "Searching for the best baud rate…")
			best, err := a.detectBestBaud(ctx, req.RigctldBin, req.RigModel, req.RigDevice, label)
			if err != nil {
				a.emitPhase(PhaseBaud, StateError, err.Error())
				return err
			}
			req.RigSpeed = best
			a.emitPhase(PhaseBaud, StateDone, fmt.Sprintf("%d baud", best))
		} else {
			a.emitPhase(PhaseBaud, StateSkipped, "Manual baud rate")
		}
	}

	// --- Phase 2: Connecting --------------------------------------------
	a.emitPhase(PhaseConnecting, StateActive, "Starting rigctld and joining server…")

	port, err := freePort()
	if err != nil {
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}
	args := spawnArgs{
		Bin:    req.RigctldBin,
		Model:  req.RigModel,
		Device: req.RigDevice,
		Speed:  req.RigSpeed,
		Host:   "127.0.0.1",
		Port:   port,
	}
	cmd, err := spawnRigctld(args)
	if err != nil {
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}
	a.mu.Lock()
	a.rigctld = cmd
	a.mu.Unlock()

	if err := waitForRigctld(args.Host, args.Port, 10*time.Second); err != nil {
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}

	a.emit("rigctld-params", rigctldParamsEvent{
		Binary:   args.Bin,
		Model:    args.Model,
		RigLabel: rigByModel(args.Model),
		Device:   args.Device,
		Speed:    args.Speed,
		Host:     args.Host,
		Port:     args.Port,
		Args:     strings.Join(args.args(), " "),
	})

	a.emitPhase(PhaseConnecting, StateDone, "rigctld is up")

	// --- Phase 3: Connected ---------------------------------------------
	a.emitPhase(PhaseConnected, StateActive, "Streaming rig state to the server")
	backend := &rigctldBackend{host: args.Host, port: args.Port}
	err = a.bridge(ctx, req, backend)
	if errors.Is(err, context.Canceled) {
		a.emitPhase(PhaseConnected, StateIdle, "Disconnected")
		return nil
	}
	a.emitPhase(PhaseConnected, StateError, err.Error())
	return err
}

// bridge is the long-running session loop: open a websocket to Noctalum,
// poll the rig backend for frequency/mode, push updates, and honour set_freq
// events.  Any non-cancellation error returns; the caller's defer releases
// the backend (kills rigctld for the rigctld path; CoUninitialize for OmniRig).
func (a *App) bridge(ctx context.Context, req ConnectRequest, rig RigBackend) error {
	u, err := url.Parse(req.Server)
	if err != nil {
		return fmt.Errorf("parse server url: %w", err)
	}
	wsScheme := "ws"
	if u.Scheme == "https" {
		wsScheme = "wss"
	}
	q := url.Values{}
	q.Set("role", "helper")
	q.Set("name", req.RigName)
	q.Set("token", req.Token)
	wsURL := fmt.Sprintf("%s://%s/ws?%s", wsScheme, u.Host, q.Encode())

	conn, resp, err := websocket.DefaultDialer.DialContext(ctx, wsURL, http.Header{
		"Origin": []string{req.Server},
	})
	if err != nil {
		// Include the configured server URL in the error so an operator who
		// accidentally points the helper at localhost (FR #63 / #64) sees
		// immediately *where* the connection failed, not just a generic
		// "ws dial: dial tcp [::1]:8080" mystery.
		if resp != nil {
			return fmt.Errorf("ws dial to %s: %w (HTTP %d)", req.Server, err, resp.StatusCode)
		}
		return fmt.Errorf("ws dial to %s: %w", req.Server, err)
	}
	defer conn.Close()
	a.emitLog("registered rig %q at %s", req.RigName, req.Server)

	// Server → helper: set_freq commands.
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var ev struct {
				Type    string `json:"type"`
				Payload struct {
					FreqHz int64  `json:"freq_hz"`
					Mode   string `json:"mode"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil {
				continue
			}
			if ev.Type == "set_freq" && ev.Payload.FreqHz > 0 {
				if err := rig.SetFreq(ev.Payload.FreqHz); err != nil {
					a.emitLog("set_freq %d: %v", ev.Payload.FreqHz, err)
				} else {
					a.emitLog("set freq → %d Hz", ev.Payload.FreqHz)
				}
				if m := toRigctldMode(ev.Payload.Mode, ev.Payload.FreqHz); m != "" {
					if err := rig.SetMode(m); err != nil {
						a.emitLog("set_mode %s: %v", m, err)
					} else {
						a.emitLog("set mode → %s", m)
					}
				}
			}
		}
	}()

	// Helper → server: rig_update polling.
	normalInterval := time.Duration(req.IntervalMs) * time.Millisecond
	const maxBackoff = 30 * time.Second
	interval := normalInterval
	errCount := 0

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		freq, mode, rigErr := rig.Read()
		if rigErr != nil {
			if errCount == 0 {
				a.emitLog("rig %q offline: %v", req.RigName, rigErr)
			}
			errCount++
			interval = rigBackoff(normalInterval, maxBackoff, errCount)
		} else {
			if errCount > 0 {
				a.emitLog("rig %q back online", req.RigName)
			}
			errCount = 0
			interval = normalInterval
			a.emit("rig-update", map[string]any{
				"freq_hz": freq,
				"mode":    mode,
			})
		}

		out := map[string]any{"type": "rig_update"}
		if rigErr != nil {
			out["error"] = rigErr.Error()
		} else {
			out["freq_hz"] = freq
			out["mode"] = mode
		}
		data, _ := json.Marshal(out)
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return err
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}
