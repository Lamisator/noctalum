package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// credentials mirrors the tiny on-disk config the C++ Qt bridge kept: a
// JSON file under the user's per-OS config dir with owner-only mode.  The
// authMode field records which flow was last used ("token" | "password")
// so the window opens in the right mode.  Passwords / tokens are only
// persisted when their respective "remember" flag is set.
type credentials struct {
	Server         string `json:"server"`
	User           string `json:"user"`
	Pass           string `json:"pass"`
	UDP            string `json:"udp"`
	RememberPass   bool   `json:"remember_pass"`
	ForceDup       bool   `json:"force_dup"`
	AuthMode       string `json:"auth_mode"`
	Token          string `json:"token"`
	RememberToken  bool   `json:"remember_token"`
}

// credentialsPath returns the absolute file path we read/write from.  Per-OS
// placement matches the layout the older Qt bridge used so users upgrading
// from v0.75 keep their saved config:
//   - Linux:   $XDG_CONFIG_HOME/Noctalum/wsjtx-bridge.json  (fallback ~/.config)
//   - macOS:   ~/Library/Application Support/Noctalum/wsjtx-bridge.json
//   - Windows: %APPDATA%/Noctalum/wsjtx-bridge.json
func credentialsPath() string {
	var dir string
	switch runtime.GOOS {
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, "Library", "Application Support", "Noctalum")
		}
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			dir = filepath.Join(v, "Noctalum")
		}
	default:
		if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
			dir = filepath.Join(v, "Noctalum")
		} else if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, ".config", "Noctalum")
		}
	}
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "wsjtx-bridge.json")
}

// loadCredentials reads the on-disk config.  Missing file → empty struct.
// A stale password/token that lingered from a previous run in which the
// operator turned off "remember" is defensively cleared.
func loadCredentials() credentials {
	f, err := os.Open(credentialsPath())
	if err != nil {
		return credentials{}
	}
	defer f.Close()
	var c credentials
	if err := json.NewDecoder(f).Decode(&c); err != nil {
		return credentials{}
	}
	if !c.RememberPass {
		c.Pass = ""
	}
	if !c.RememberToken {
		c.Token = ""
	}
	return c
}

// saveCredentials persists c.  On POSIX the file lands with mode 0600 so a
// cached password/token can't be read by another user on the machine.
// Windows relies on the per-user ACL that %APPDATA% already carries.
func saveCredentials(c credentials) error {
	if !c.RememberPass {
		c.Pass = ""
	}
	if !c.RememberToken {
		c.Token = ""
	}
	path := credentialsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// O_TRUNC so we don't leave stale bytes from a longer previous write.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

// clearCredentials deletes the on-disk file — used by the "Forget saved
// credentials" button.  A missing file is a no-op, not an error.
func clearCredentials() error {
	err := os.Remove(credentialsPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
