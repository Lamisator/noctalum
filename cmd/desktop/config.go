// Config persistence for noctalum-desktop.
//
// The wrapper caches two things between launches:
//   • The Noctalum server URL, so the operator doesn't retype it.
//   • The username, so it can be prefilled into the server's login form.
//
// Passwords are never written to disk.  The session cookie is not
// persisted here either — it lives in the OS-specific webview data dir
// managed by Wails (see main.go), so an intact session survives restarts
// without the wrapper having to touch it.
package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// configFileName is the on-disk name.  Relative to the OS user-config dir
// under the "noctalum-desktop" subfolder.
const configFileName = "config.json"

// Config is the JSON persisted between launches.
type Config struct {
	ServerURL string `json:"server_url,omitempty"`
	Username  string `json:"username,omitempty"`
}

// configStore is a thin, mutex-guarded wrapper so concurrent writes from
// the frontend (e.g. RememberUsername firing while ConnectServer runs)
// don't clobber each other.
type configStore struct {
	mu   sync.Mutex
	path string
	data Config
}

func newConfigStore() (*configStore, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(base, "noctalum-desktop")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	cs := &configStore{path: filepath.Join(dir, configFileName)}
	if err := cs.load(); err != nil {
		return nil, err
	}
	return cs, nil
}

func (c *configStore) load() error {
	b, err := os.ReadFile(c.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // first launch — leave defaults zeroed
		}
		return err
	}
	// Corrupt file shouldn't break the wrapper; fall back to defaults and
	// let the next save overwrite it.
	if err := json.Unmarshal(b, &c.data); err != nil {
		c.data = Config{}
	}
	return nil
}

func (c *configStore) get() Config {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.data
}

// update applies mut under the lock and immediately persists the result
// so that a crash between two updates doesn't lose the more recent one.
func (c *configStore) update(mut func(*Config)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	mut(&c.data)
	b, err := json.MarshalIndent(&c.data, "", "  ")
	if err != nil {
		return err
	}
	// Write to a sibling temp file and rename, so a crash mid-write can't
	// leave the config truncated.
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}
