package main

import (
	"context"
	"errors"
	"fmt"
)

// detectResult is the outcome of a successful auto-detection: we found a
// rig responding on this device + model + speed.
type detectResult struct {
	Device string
	Model  int
	Label  string
	Speed  int
}

// detectTRX walks every (device, rig-preset) pair until one responds at
// the rig's default speed.  We don't fan out across baud rates here — the
// follow-up baud phase does that — because most rigs are happy at their
// factory default and trying every cross-product would multiply the wait.
func (a *App) detectTRX(ctx context.Context, rigctldBin string, devices []string) (*detectResult, error) {
	if len(devices) == 0 {
		return nil, errors.New("no serial port available — connect the rig and retry")
	}
	for _, dev := range devices {
		for _, rig := range curatedRigs {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
			a.emitPhase(PhaseDetectTRX, StateActive,
				fmt.Sprintf("Trying %s on %s @ %d baud", rig.Label, dev, rig.DefaultSpeed))

			port, err := freePort()
			if err != nil {
				return nil, fmt.Errorf("free port: %w", err)
			}
			args := spawnArgs{
				Bin:    rigctldBin,
				Model:  rig.Model,
				Device: dev,
				Speed:  rig.DefaultSpeed,
				Host:   "127.0.0.1",
				Port:   port,
			}
			if _, err := probeOnce(ctx, args); err == nil {
				a.emitLog("detected %s on %s @ %d baud", rig.Label, dev, rig.DefaultSpeed)
				return &detectResult{
					Device: dev,
					Model:  rig.Model,
					Label:  rig.Label,
					Speed:  rig.DefaultSpeed,
				}, nil
			}
		}
	}
	return nil, errors.New("no known transceiver responded — use manual configuration")
}

// detectBestBaud takes a known-working rig and tries faster baud rates,
// stopping at the highest that still responds.  Falls back to the seed
// speed when nothing faster works.
func (a *App) detectBestBaud(ctx context.Context, rigctldBin string, seed detectResult) int {
	for _, baud := range probeBauds {
		if baud < seed.Speed {
			break
		}
		select {
		case <-ctx.Done():
			return seed.Speed
		default:
		}
		a.emitPhase(PhaseBaud, StateActive,
			fmt.Sprintf("Testing %s on %s @ %d baud", seed.Label, seed.Device, baud))

		port, err := freePort()
		if err != nil {
			continue
		}
		args := spawnArgs{
			Bin:    rigctldBin,
			Model:  seed.Model,
			Device: seed.Device,
			Speed:  baud,
			Host:   "127.0.0.1",
			Port:   port,
		}
		if _, err := probeOnce(ctx, args); err == nil {
			a.emitLog("baud %d ok — using %d", baud, baud)
			return baud
		}
	}
	a.emitLog("falling back to seed baud %d", seed.Speed)
	return seed.Speed
}
