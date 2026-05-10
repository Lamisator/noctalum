package main

import (
	"context"
	"errors"
	"fmt"
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
		if _, err := probeOnce(ctx, args); err == nil {
			a.emitLog("baud %d ok", baud)
			return baud, nil
		}
	}
	return 0, errors.New("no baud rate worked — check the cable, rig power, and selected model")
}
