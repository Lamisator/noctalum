#pragma once

#include "common.hpp"

namespace nhelper {

// Load config from disk.  Tries paths in the same priority order as the Go
// helper's loadSettings():
//   1. $XDG_CONFIG_HOME/noctalum/noctalum-helper-gui.json    (shared GUI store)
//   2. $XDG_CONFIG_HOME/noctalum/noctalum-helper.json        (this tool's own)
//   3. $XDG_CONFIG_HOME/contestlog/contestlog-helper-gui.json (legacy)
//   4. $XDG_CONFIG_HOME/contestlog/contestlog-helper.json    (legacy)
// Returns a default-constructed Config if nothing is found.
Config load_config();

// Persist config to both the shared GUI store and the TUI-only legacy file, so
// the desktop GUI and the CLI stay in sync.
void save_config(const Config& c);

// Return "$XDG_CONFIG_HOME/noctalum" (creating no directories).  Falls back to
// "$HOME/.config/noctalum" when XDG_CONFIG_HOME is unset.
std::string config_dir();

}  // namespace nhelper
