package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Profile is a complete, named configuration for one transceiver setup.
// Profiles are user-named so an operator can keep e.g. "Shack IC-7300" and
// "Field IC-705" entries side by side and switch with one click.
type Profile struct {
	Name       string `json:"name"`
	Server     string `json:"server"`
	Token      string `json:"token"`
	RigName    string `json:"rig_name"`
	RigModel   int    `json:"rig_model"`
	RigDevice  string `json:"rig_device"`
	RigSpeed   int    `json:"rig_speed"`
	RigctldBin      string `json:"rigctld_bin"`
	IntervalMs      int    `json:"interval_ms"`
	AutoDetect      bool   `json:"auto_detect"`
	AutoDetectModel bool   `json:"auto_detect_model"`
}

// ProfileStore is the on-disk shape of noctalum-helper-gui.json.  It is
// returned to the frontend verbatim so JS can render the profile picker.
type ProfileStore struct {
	Profiles []Profile `json:"profiles"`
	LastUsed string    `json:"last_used"`
}

const guiSettingsFile = "noctalum-helper-gui.json"

func guiSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "noctalum", guiSettingsFile), nil
}

// legacyGuiSettingsPath returns the path used by the old ContestLog release.
func legacyGuiSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "contestlog", "contestlog-helper-gui.json"), nil
}

func loadProfileStore() ProfileStore {
	for _, pathFn := range []func() (string, error){guiSettingsPath, legacyGuiSettingsPath} {
		path, err := pathFn()
		if err != nil {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var s ProfileStore
		if json.Unmarshal(data, &s) == nil {
			return s
		}
	}
	return ProfileStore{}
}

func (s *ProfileStore) save() error {
	path, err := guiSettingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func (s *ProfileStore) upsert(p Profile) {
	for i, existing := range s.Profiles {
		if existing.Name == p.Name {
			s.Profiles[i] = p
			s.LastUsed = p.Name
			return
		}
	}
	s.Profiles = append(s.Profiles, p)
	s.LastUsed = p.Name
}

func (s *ProfileStore) remove(name string) {
	out := s.Profiles[:0]
	for _, p := range s.Profiles {
		if p.Name != name {
			out = append(out, p)
		}
	}
	s.Profiles = out
	if s.LastUsed == name {
		s.LastUsed = ""
	}
}
