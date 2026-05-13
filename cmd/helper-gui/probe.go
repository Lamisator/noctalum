package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// probeStartup / probeQuery are the per-attempt timeouts used during auto-detect.
// A correct rig responds in milliseconds; a wrong model/baud just times out, so
// keeping these short cuts the worst-case scan time significantly.
// Multiple rigctld instances on the SAME serial device would conflict (the OS
// grants exclusive port access via TIOCEXCL), so probes remain sequential; the
// gains come from shorter timeouts and not blocking on zombie reap between probes.
const (
	probeStartup = 1500 * time.Millisecond
	probeQuery   = 800 * time.Millisecond
)

// detectBestBaud probes baud rates highest-to-lowest for the chosen rig
// and returns the highest one that responds.  When the model is in the
// curated preset list, its default speed is used as a floor — there is no
// point trying anything slower than what the rig is documented to accept.
func (a *App) detectBestBaud(ctx context.Context, rigctldBin string, model int, device, label string) (int, error) {
	floor := 0
	for _, r := range curatedRigs {
		if r.Model == model {
			floor = r.DefaultSpeed
			break
		}
	}
	for _, baud := range probeBauds {
		if floor > 0 && baud < floor {
			break
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}
		a.emitPhase(PhaseBaud, StateActive,
			fmt.Sprintf("Testing %s on %s @ %d baud", label, device, baud))

		port, err := freePort()
		if err != nil {
			continue
		}
		args := spawnArgs{
			Bin:    rigctldBin,
			Model:  model,
			Device: device,
			Speed:  baud,
			Host:   "127.0.0.1",
			Port:   port,
		}
		if _, err := probeOnce(ctx, args, probeStartup, probeQuery); err == nil {
			a.emitLog("baud %d ok", baud)
			return baud, nil
		}
	}
	return 0, errors.New("no baud rate worked — check the cable, rig power, and selected model")
}

// detectModel brute-forces the full Hamlib rig list × all baud rates on the
// given serial device and returns the first (model, baud, label) combination
// that yields a valid frequency reading.  The curated list is tried first so
// common transceivers are found in seconds; the remainder of the Hamlib
// database follows for exhaustive coverage.
func (a *App) detectModel(ctx context.Context, rigctldBin, device string) (model, baud int, label string, err error) {
	all := queryAllRigs(rigctldBin)
	if len(all) == 0 {
		all = make([]RigPreset, len(curatedRigs))
		copy(all, curatedRigs)
	}

	// Curated rigs first, then the rest of the full list.
	curatedIdx := make(map[int]bool, len(curatedRigs))
	for _, r := range curatedRigs {
		curatedIdx[r.Model] = true
	}
	ordered := make([]RigPreset, 0, len(all))
	ordered = append(ordered, curatedRigs...)
	for _, r := range all {
		if !curatedIdx[r.Model] && !isSoftwareRig(r) {
			ordered = append(ordered, r)
		}
	}

	total := len(ordered) * len(probeBauds)
	tried := 0

	for _, rig := range ordered {
		for _, b := range probeBauds {
			tried++
			select {
			case <-ctx.Done():
				return 0, 0, "", ctx.Err()
			default:
			}

			pct := tried * 100 / total
			a.emitPhase(PhaseModel, StateActive, fmt.Sprintf(
				"[%d%%] %s %s @ %d baud", pct, rig.Vendor, rig.Label, b))

			port, portErr := freePort()
			if portErr != nil {
				continue
			}
			args := spawnArgs{
				Bin:    rigctldBin,
				Model:  rig.Model,
				Device: device,
				Speed:  b,
				Host:   "127.0.0.1",
				Port:   port,
			}
			if _, probeErr := probeOnce(ctx, args, probeStartup, probeQuery); probeErr == nil {
				lbl := rig.Vendor + " " + rig.Label
				a.emitLog("model detected: %s (model %d) @ %d baud", lbl, rig.Model, b)
				return rig.Model, b, lbl, nil
			}
		}
	}
	return 0, 0, "", fmt.Errorf("no rig detected on %s — check the cable and rig power", device)
}

// isSoftwareRig returns true for Hamlib internal/virtual rig entries that
// cannot be connected via a serial port (dummy, net rigctl, demo, etc.).
func isSoftwareRig(r RigPreset) bool {
	if strings.EqualFold(r.Vendor, "Hamlib") {
		return true
	}
	lower := strings.ToLower(r.Label)
	return strings.Contains(lower, "dummy") ||
		strings.Contains(lower, "demo") ||
		strings.Contains(lower, "net rigctl")
}
