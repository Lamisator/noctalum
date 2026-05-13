package main

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/rivo/tview"
)

var errCancelled = errors.New("cancelled")

type rigPreset struct {
	label string
	model int
	speed int
}

var builtinPresets = []rigPreset{
	{"IC-7300", 3073, 0},
	{"IC-705", 3085, 0},
	{"Custom", 0, 0},
}

type tuiConfig struct {
	Server     string `json:"server"`
	Name       string `json:"name"`
	Token      string `json:"token"`
	RigModel   int    `json:"rig_model"`
	RigDevice  string `json:"rig_device"`
	RigSpeed   int    `json:"rig_speed"`
	RigctldBin string `json:"rigctld_bin"`
	IntervalMs int    `json:"interval_ms"`
}

func runTUI() (tuiConfig, error) {
	saved := loadSettings()

	// Resolve display defaults: saved values take priority, IC-7300 preset as fallback.
	p0 := builtinPresets[0]
	str := func(s, fallback string) string {
		if s != "" {
			return s
		}
		return fallback
	}
	// intStr converts an int to string; returns "" for 0 (meaning "use default").
	intStr := func(v, fallback int) string {
		if v != 0 {
			return strconv.Itoa(v)
		}
		if fallback != 0 {
			return strconv.Itoa(fallback)
		}
		return ""
	}
	// intOrEmpty accepts digits or an empty field.
	intOrEmpty := func(text string, _ rune) bool {
		if text == "" {
			return true
		}
		_, err := strconv.Atoi(text)
		return err == nil
	}

	// Find which preset matches the saved rig model (for the dropdown initial selection).
	initialPreset := len(builtinPresets) - 1 // "Custom" by default
	for i, p := range builtinPresets {
		if p.model != 0 && p.model == saved.RigModel {
			initialPreset = i
			break
		}
	}

	// Detect available serial ports for the rig device field.
	detectedPorts := detectSerialPorts()
	usePortDropdown := len(detectedPorts) > 0

	// Build the dropdown option list, ensuring the saved device is always present.
	var portOptions []string
	initialPortIdx := 0
	var selectedDevice string
	if usePortDropdown {
		portOptions = append(portOptions, detectedPorts...)
		if saved.RigDevice != "" {
			found := false
			for i, p := range portOptions {
				if p == saved.RigDevice {
					initialPortIdx = i
					found = true
					break
				}
			}
			if !found {
				portOptions = append(portOptions, saved.RigDevice)
				initialPortIdx = len(portOptions) - 1
			}
		}
		selectedDevice = portOptions[initialPortIdx]
	}

	app := tview.NewApplication()
	var result tuiConfig
	var submitted bool

	presetNames := make([]string, len(builtinPresets))
	for i, p := range builtinPresets {
		presetNames[i] = p.label
	}

	form := tview.NewForm()

	inp := func(label string) *tview.InputField {
		item := form.GetFormItemByLabel(label)
		if item == nil {
			return nil
		}
		f, ok := item.(*tview.InputField)
		if !ok {
			return nil
		}
		return f
	}

	set := func(label, text string) {
		if f := inp(label); f != nil {
			f.SetText(text)
		}
	}

	showError := func(msg string) {
		modal := tview.NewModal().
			SetText(msg).
			AddButtons([]string{"OK"}).
			SetDoneFunc(func(_ int, _ string) {
				app.SetRoot(form, true)
			})
		app.SetRoot(modal, false)
	}

	// initializing suppresses the preset auto-fill while we're building the form.
	initializing := true

	form.
		AddDropDown("Preset", presetNames, initialPreset, func(_ string, index int) {
			if initializing {
				return
			}
			p := builtinPresets[index]
			if p.model == 0 {
				return // Custom — leave fields as-is
			}
			set("Rig Name", p.label)
			set("Rig Model", strconv.Itoa(p.model))
			if p.speed != 0 {
				set("Serial Speed", strconv.Itoa(p.speed))
			} else {
				set("Serial Speed", "")
			}
		}).
		AddInputField("Server URL", str(saved.Server, "http://localhost:8080"), 40, nil, nil).
		AddInputField("Rig Name", str(saved.Name, p0.label), 30, nil, nil).
		AddPasswordField("Helper Token", saved.Token, 40, '*', nil).
		AddInputField("Rig Model", intStr(saved.RigModel, p0.model), 10, tview.InputFieldInteger, nil)

	if usePortDropdown {
		form.AddDropDown("Serial Device", portOptions, initialPortIdx, func(option string, _ int) {
			selectedDevice = option
		})
	} else {
		form.AddInputField("Serial Device", str(saved.RigDevice, ""), 30, nil, nil)
	}

	form.
		AddInputField("Serial Speed", intStr(saved.RigSpeed, p0.speed), 10, intOrEmpty, nil).
		AddInputField("rigctld path", str(saved.RigctldBin, defaultRigctldBin()), 40, nil, nil).
		AddInputField("Interval (ms)", intStr(saved.IntervalMs, 1000), 10, tview.InputFieldInteger, nil).
		AddButton("Start", func() {
			server := inp("Server URL").GetText()
			name := inp("Rig Name").GetText()
			token := inp("Helper Token").GetText()
			switch {
			case server == "":
				showError("Server URL is required.")
				return
			case name == "":
				showError("Rig Name is required.")
				return
			case token == "":
				showError("Helper Token is required.")
				return
			}
			model, _ := strconv.Atoi(inp("Rig Model").GetText())
			speed, _ := strconv.Atoi(inp("Serial Speed").GetText())
			interval, _ := strconv.Atoi(inp("Interval (ms)").GetText())
			if interval < 250 {
				interval = 250
			}
			var device string
			if usePortDropdown {
				device = selectedDevice
			} else {
				device = inp("Serial Device").GetText()
			}
			result = tuiConfig{
				Server:     server,
				Name:       name,
				Token:      token,
				RigModel:   model,
				RigDevice:  device,
				RigSpeed:   speed,
				RigctldBin: inp("rigctld path").GetText(),
				IntervalMs: interval,
			}
			saveSettings(result)
			submitted = true
			app.Stop()
		}).
		AddButton("Quit", func() {
			app.Stop()
		})

	initializing = false

	form.
		SetBorder(true).
		SetTitle(fmt.Sprintf(" Noctalum Helper v%s ", helperVersion)).
		SetTitleAlign(tview.AlignCenter)

	if err := app.SetRoot(form, true).EnableMouse(true).Run(); err != nil {
		return tuiConfig{}, err
	}
	if !submitted {
		return tuiConfig{}, errCancelled
	}
	return result, nil
}
