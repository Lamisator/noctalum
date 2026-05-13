// noctalum-helper-gui is the desktop GUI version of the Noctalum rig
// helper.  It wraps the same rigctld bridge as cmd/helper but presents a
// Wails-based UI that auto-detects the serial port, the transceiver model,
// and the working baud rate before connecting.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

const helperVersion = "0.1.0"

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "Noctalum Helper",
		Width:            960,
		Height:           780,
		MinWidth:         720,
		MinHeight:        640,
		BackgroundColour: &options.RGBA{R: 18, G: 20, B: 23, A: 255}, // matches --bg
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Linux: &linux.Options{
			ProgramName: "Noctalum Helper",
		},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About: &mac.AboutInfo{
				Title:   "Noctalum Helper",
				Message: "Auto-configuring rig helper for Noctalum.",
			},
		},
	})
	if err != nil {
		log.Fatalf("wails: %v", err)
	}
}
