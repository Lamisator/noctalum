package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const settingsFile = "noctalum-helper.json"

func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "noctalum", settingsFile), nil
}

func oldSharedSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "contestlog", "contestlog-helper-gui.json"), nil
}

func oldSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "contestlog", "contestlog-helper.json"), nil
}

// sharedProfile mirrors cmd/helper-gui/profiles.go:Profile so that both tools
// read and write the same on-disk format.
type sharedProfile struct {
	Name       string `json:"name"`
	Server     string `json:"server"`
	Token      string `json:"token"`
	RigName    string `json:"rig_name"`
	RigModel   int    `json:"rig_model"`
	RigDevice  string `json:"rig_device"`
	RigSpeed   int    `json:"rig_speed"`
	RigctldBin string `json:"rigctld_bin"`
	IntervalMs int    `json:"interval_ms"`
	AutoDetect bool   `json:"auto_detect"`
}

type sharedProfileStore struct {
	Profiles []sharedProfile `json:"profiles"`
	LastUsed string          `json:"last_used"`
}

func sharedSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "noctalum", "noctalum-helper-gui.json"), nil
}

// loadSettings returns the last-used profile, trying paths in order:
//  1. noctalum/noctalum-helper-gui.json  (current shared GUI store)
//  2. noctalum/noctalum-helper.json      (current TUI-only store)
//  3. contestlog/contestlog-helper-gui.json  (old ContestLog GUI store)
//  4. contestlog/contestlog-helper.json      (old ContestLog TUI-only store)
func loadSettings() tuiConfig {
	for _, pathFn := range []func() (string, error){sharedSettingsPath, oldSharedSettingsPath} {
		if cfg, ok := loadSharedProfileFile(pathFn); ok {
			return cfg
		}
	}
	for _, pathFn := range []func() (string, error){settingsPath, oldSettingsPath} {
		path, err := pathFn()
		if err != nil {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var cfg tuiConfig
		if json.Unmarshal(data, &cfg) == nil {
			return cfg
		}
	}
	return tuiConfig{}
}

func loadSharedProfileFile(pathFn func() (string, error)) (tuiConfig, bool) {
	path, err := pathFn()
	if err != nil {
		return tuiConfig{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return tuiConfig{}, false
	}
	var store sharedProfileStore
	if err := json.Unmarshal(data, &store); err != nil || len(store.Profiles) == 0 {
		return tuiConfig{}, false
	}
	p := store.Profiles[0]
	for _, prof := range store.Profiles {
		if prof.Name == store.LastUsed {
			p = prof
			break
		}
	}
	return tuiConfig{
		Server:     p.Server,
		Name:       p.RigName,
		Token:      p.Token,
		RigModel:   p.RigModel,
		RigDevice:  p.RigDevice,
		RigSpeed:   p.RigSpeed,
		RigctldBin: p.RigctldBin,
		IntervalMs: p.IntervalMs,
	}, true
}

// saveSettings writes cfg to the shared GUI profile store (so both the GUI and
// the TUI CLI see the same credentials) and also to the legacy TUI-only file
// for backwards compatibility.
func saveSettings(cfg tuiConfig) {
	saveToShared(cfg)
	saveLegacy(cfg)
}

func saveToShared(cfg tuiConfig) {
	path, err := sharedSettingsPath()
	if err != nil {
		return
	}
	var store sharedProfileStore
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &store)
	}
	profileName := cfg.Name
	if profileName == "" {
		profileName = "Default"
	}
	p := sharedProfile{
		Name:       profileName,
		Server:     cfg.Server,
		Token:      cfg.Token,
		RigName:    cfg.Name,
		RigModel:   cfg.RigModel,
		RigDevice:  cfg.RigDevice,
		RigSpeed:   cfg.RigSpeed,
		RigctldBin: cfg.RigctldBin,
		IntervalMs: cfg.IntervalMs,
	}
	updated := false
	for i, existing := range store.Profiles {
		if existing.Name == profileName {
			store.Profiles[i] = p
			updated = true
			break
		}
	}
	if !updated {
		store.Profiles = append(store.Profiles, p)
	}
	store.LastUsed = profileName
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o600)
}

func saveLegacy(cfg tuiConfig) {
	path, err := settingsPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o600)
}
