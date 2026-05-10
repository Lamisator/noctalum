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
// AutoDetect=true tells the helper to run the TRX + baud probe phases first;
// otherwise we go straight to "Connecting" using whatever the request set.
type ConnectRequest struct {
	AutoDetect bool   `json:"auto_detect"`
	Server     string `json:"server"`
	Token      string `json:"token"`
	RigName    string `json:"rig_name"`
	RigModel   int    `json:"rig_model"`
	RigDevice  string `json:"rig_device"`
	RigSpeed   int    `json:"rig_speed"`
	RigctldBin string `json:"rigctld_bin"`
	IntervalMs int    `json:"interval_ms"`
}

// runSession is the goroutine started by Connect; it walks the four phases
// and then runs the rigctld → ContestLog bridge until ctx is cancelled.
func (a *App) runSession(ctx context.Context, req ConnectRequest) error {
	if req.RigctldBin == "" {
		req.RigctldBin = defaultRigctldBin()
	}
	if req.IntervalMs < 250 {
		req.IntervalMs = 1000
	}
	if req.Server == "" || req.Token == "" || req.RigName == "" {
		err := errors.New("Server URL, token, and rig name are required")
		a.emitPhase(PhaseConnecting, StateError, err.Error())
		return err
	}

	// --- Phase 1: Determining TRX ----------------------------------------
	if req.AutoDetect {
		a.emitPhase(PhaseDetectTRX, StateActive, "Detecting transceiver…")

		devices := []string{req.RigDevice}
		if req.RigDevice == "" {
			devices = detectSerialPorts()
		}
		res, err := a.detectTRX(ctx, req.RigctldBin, devices)
		if err != nil {
			a.emitPhase(PhaseDetectTRX, StateError, err.Error())
			return err
		}
		a.emitPhase(PhaseDetectTRX, StateDone,
			fmt.Sprintf("%s on %s", res.Label, res.Device))
		req.RigModel = res.Model
		req.RigDevice = res.Device
		// Seed speed; the baud phase tries to upgrade from this floor.
		req.RigSpeed = res.Speed

		// --- Phase 2: Testing baud rate ----------------------------------
		a.emitPhase(PhaseBaud, StateActive, "Searching for the best baud rate…")
		best := a.detectBestBaud(ctx, req.RigctldBin, *res)
		req.RigSpeed = best
		a.emitPhase(PhaseBaud, StateDone, fmt.Sprintf("%d baud", best))
	} else {
		a.emitPhase(PhaseDetectTRX, StateSkipped, "Manual configuration")
		a.emitPhase(PhaseBaud, StateSkipped, "Manual configuration")
	}

	// --- Phase 3: Connecting --------------------------------------------
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

	// --- Phase 4: Connected ---------------------------------------------
	a.emitPhase(PhaseConnected, StateActive, "Streaming rig state to the server")
	err = a.bridge(ctx, req, args.Host, args.Port)
	if errors.Is(err, context.Canceled) {
		a.emitPhase(PhaseConnected, StateIdle, "Disconnected")
		return nil
	}
	a.emitPhase(PhaseConnected, StateError, err.Error())
	return err
}

// bridge is the long-running session loop: open a websocket to ContestLog,
// poll rigctld for frequency/mode, push updates, and honour set_freq events.
// Any non-cancellation error returns; the caller's defer kills rigctld.
func (a *App) bridge(ctx context.Context, req ConnectRequest, rigHost string, rigPort int) error {
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
		if resp != nil {
			return fmt.Errorf("ws dial: %w (HTTP %d)", err, resp.StatusCode)
		}
		return fmt.Errorf("ws dial: %w", err)
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
				if err := setRigFreq(rigHost, rigPort, ev.Payload.FreqHz); err != nil {
					a.emitLog("set_freq %d: %v", ev.Payload.FreqHz, err)
				} else {
					a.emitLog("set freq → %d Hz", ev.Payload.FreqHz)
				}
				if m := toRigctldMode(ev.Payload.Mode, ev.Payload.FreqHz); m != "" {
					if err := setRigMode(rigHost, rigPort, m); err != nil {
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

		freq, mode, rigErr := readRig(rigHost, rigPort)
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
