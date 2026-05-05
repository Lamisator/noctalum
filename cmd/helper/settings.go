package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const settingsFile = "contestlog-helper.json"

func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "contestlog", settingsFile), nil
}

func loadSettings() tuiConfig {
	path, err := settingsPath()
	if err != nil {
		return tuiConfig{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return tuiConfig{}
	}
	var cfg tuiConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return tuiConfig{}
	}
	return cfg
}

func saveSettings(cfg tuiConfig) {
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
