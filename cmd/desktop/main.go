// noctalum-desktop is a native desktop wrapper (Wails v2) for the
// Noctalum web application.  It shows a small server-URL prompt on
// first launch, then loads the operator's Noctalum server directly in
// the webview.  The session cookie is persisted by the webview across
// launches, so subsequent starts jump straight into the logged-in app.
package main

import (
	"embed"
	"flag"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

const desktopVersion = "0.1.0"

//go:embed all:frontend/dist
var assets embed.FS

//go:embed frontend/dist/noctalum.png
var appIcon []byte

func main() {
	// -url is set by OpenPanelWindow when we spawn ourselves as a
	// secondary window; the child skips the server-URL prompt and
	// navigates straight to this URL.  Not intended for interactive use.
	overrideURL := flag.String("url", "", "internal: secondary-window target URL (used by pop-out)")
	flag.Parse()

	cfg, err := newConfigStore()
	if err != nil {
		log.Fatalf("noctalum-desktop: config: %v", err)
	}
	app := newApp(cfg, *overrideURL)

	w, h, bg := app.desktopWindowOptions()

	err = wails.Run(&options.App{
		Title:            "Noctalum",
		Width:            w,
		Height:           h,
		MinWidth:         960,
		MinHeight:        600,
		BackgroundColour: &bg,
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnDomReady:       app.onDomReady,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Linux: &linux.Options{
			ProgramName: "Noctalum",
			Icon:        appIcon,
		},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About: &mac.AboutInfo{
				Title:   "Noctalum",
				Message: "Native desktop wrapper for the Noctalum contest logger.",
			},
		},
		// A persistent WebView2 user-data folder is essential: it's where
		// the session cookie lives between launches.  Wails' default
		// (%LocalAppData%\<name>) is fine for our purposes.
		Windows: &windows.Options{
			WebviewUserDataPath: "", // → default per-app dir
		},
	})
	if err != nil {
		log.Fatalf("noctalum-desktop: wails: %v", err)
	}
}
